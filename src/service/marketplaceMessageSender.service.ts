import axios from 'axios';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { AppDataSource } from '../config/database';
import { Conversation } from '../entity/Conversation';
import { MarketplaceCredentials } from '../entity/MarketplaceCredentials';
import { Message } from '../entity/Message';
import { emitConversationUpdated, emitMessageCreated } from './socket.service';

const defaultTenantId =
  process.env.DEFAULT_TENANT_ID || '20000000-0000-0000-0000-000000000001';
const defaultCredentialEncryptionKey =
  'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

function decryptMarketplaceSecret(value: string) {
  if (!value.startsWith('v1:')) {
    return value;
  }

  const encryptionKey = Buffer.from(
    process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY ||
      defaultCredentialEncryptionKey,
    'base64',
  );
  const payload = Buffer.from(value.slice(3), 'base64');
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(payload.length - 16);
  const encrypted = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
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
    const marketplaceAccount = conversation.marketplaceAccount;
    const now = new Date();

    if (
      marketplaceAccount.connectionStatus !== 'CONNECTED' ||
      marketplaceAccount.deletedAt ||
      (marketplaceAccount.expiresAt && marketplaceAccount.expiresAt <= now)
    ) {
      throw new Error('Marketplace account is not connected.');
    }

    const credentials = await credentialsRepository.findOneBy({
      marketplaceAccountId: conversation.marketplaceAccountId,
    });

    if (!credentials) {
      throw new Error('Marketplace credential is missing.');
    }

    if (credentials.accessTokenExpiresAt && credentials.accessTokenExpiresAt <= now) {
      throw new Error('Marketplace seller access token is expired.');
    }

    const accessToken = decryptMarketplaceSecret(credentials.accessTokenEncrypted);

    if (!accessToken) {
      throw new Error('Marketplace seller access token is missing.');
    }

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
