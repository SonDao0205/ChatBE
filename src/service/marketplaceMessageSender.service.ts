import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../config/database';
import { Conversation } from '../entity/Conversation';
import { MarketplaceCredentials } from '../entity/MarketplaceCredentials';
import { Message } from '../entity/Message';
import { emitConversationUpdated, emitMessageCreated } from './socket.service';

const defaultTenantId =
  process.env.DEFAULT_TENANT_ID || '20000000-0000-0000-0000-000000000001';

function decryptMarketplaceSecret(value: string) {
  return value;
}

function getFallbackAccessToken(marketplaceCode: string) {
  if (marketplaceCode === 'TIKTOK_SHOP') {
    return process.env.TIKTOK_SELLER_ACCESS_TOKEN || null;
  }
  if (marketplaceCode === 'LAZADA') {
    return process.env.LAZADA_SELLER_ACCESS_TOKEN || null;
  }
  return null;
}

export class MarketplaceMessageSenderService {
  async sendSellerMessage(input: {
    conversationId: string;
    text: string;
    tenantId?: string;
    senderUserId?: string;
  }) {
    const tenantId = input.tenantId || defaultTenantId;
    const text = input.text.trim();

    if (!text) {
      throw new Error('Message text is required.');
    }

    const conversationRepository = AppDataSource.getRepository(Conversation);
    const messageRepository = AppDataSource.getRepository(Message);
    const credentialsRepository = AppDataSource.getRepository(MarketplaceCredentials);

    const conversation = await conversationRepository.findOneOrFail({
      where: {
        id: input.conversationId,
        tenantId,
      },
      relations: {
        marketplaceAccount: {
          marketplace: true,
        },
      },
    });

    const marketplaceCode =
      conversation.marketplaceAccount.marketplace.marketplaceCode;
    const clientMessageId = randomUUID();

    const queuedMessage = messageRepository.create({
      id: randomUUID(),
      tenantId,
      conversationId: conversation.id,
      externalMessageId: null,
      clientMessageId,
      direction: 'OUTBOUND',
      senderType: 'STAFF',
      senderUserId: input.senderUserId || null,
      messageType: 'TEXT',
      textContent: text,
      contentJson: {},
      rawPayload: {},
      deliveryStatus: 'QUEUED',
      moderationStatus: 'NOT_CHECKED',
      errorMessage: null,
      queuedAt: new Date(),
      sentAt: null,
      failedAt: null,
      externalCreatedAt: null,
    });
    const message = await messageRepository.save(queuedMessage);

    emitMessageCreated(conversation.id, {
      conversationId: conversation.id,
      message,
    });

    try {
      const credentials = await credentialsRepository.findOneBy({
        marketplaceAccountId: conversation.marketplaceAccountId,
      });
      const accessToken = credentials
        ? decryptMarketplaceSecret(credentials.accessTokenEncrypted)
        : getFallbackAccessToken(marketplaceCode);

      if (!accessToken) {
        throw new Error('Marketplace seller access token is missing.');
      }

      const baseUrl = conversation.marketplaceAccount.marketplace.mockBaseUrl;
      if (!baseUrl) {
        throw new Error(`Marketplace ${marketplaceCode} does not have mock_base_url.`);
      }

      const endpointUrl = new URL('/mock/seller/messages', baseUrl).toString();
      const response = await axios.post(
        endpointUrl,
        {
          externalConversationId: conversation.externalConversationId,
          text,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Idempotency-Key': clientMessageId,
            'Content-Type': 'application/json',
          },
        },
      );

      const responseData = response.data?.data ?? response.data;
      const sentAt = new Date();

      message.externalMessageId = String(responseData.message_id);
      message.deliveryStatus = 'SENT';
      message.sentAt = sentAt;
      message.rawPayload = response.data;

      conversation.lastMessageId = message.id;
      conversation.lastMessagePreview = text;
      conversation.lastMessageAt = sentAt;

      await messageRepository.save(message);
      await conversationRepository.save(conversation);

      emitMessageCreated(conversation.id, {
        conversationId: conversation.id,
        message,
      });
      emitConversationUpdated(conversation.id, {
        conversationId: conversation.id,
        conversation,
      });

      return message;
    } catch (error) {
      message.deliveryStatus = 'FAILED';
      message.failedAt = new Date();
      message.errorMessage =
        error instanceof Error ? error.message : 'Cannot send marketplace message.';

      await messageRepository.save(message);

      emitMessageCreated(conversation.id, {
        conversationId: conversation.id,
        message,
      });

      throw error;
    }
  }
}
