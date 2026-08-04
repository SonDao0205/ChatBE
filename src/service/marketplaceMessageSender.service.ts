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
    senderType?: 'STAFF' | 'AI';
    aiResponseRunId?: string;
    idempotencyKey?: string;
  }) {
    const tenantId = input.tenantId || defaultTenantId;
    const text = input.text.trim();

    if (!text) {
      throw new Error('Message text is required.');
    }

    const conversationRepository = AppDataSource.getRepository(Conversation);
    const messageRepository = AppDataSource.getRepository(Message);
    const credentialsRepository = AppDataSource.getRepository(MarketplaceCredentials);
    const clientMessageId = input.idempotencyKey || randomUUID();
    let message = input.idempotencyKey
      ? await messageRepository.findOne({
          where: {
            tenantId,
            conversationId: input.conversationId,
            clientMessageId,
          },
        })
      : null;

    if (message && message.deliveryStatus !== 'FAILED') {
      return message;
    }
    if (message && message.textContent !== text) {
      throw new Error('Idempotency key was already used with different message text.');
    }

    const conversation = await conversationRepository
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.marketplaceAccount', 'account')
      .innerJoinAndSelect('account.marketplace', 'marketplace')
      .where('conversation.id = :conversationId', {
        conversationId: input.conversationId,
      })
      .andWhere('conversation.tenant_id = :tenantId', { tenantId })
      .andWhere('account.connection_status = :connectionStatus', {
        connectionStatus: 'CONNECTED',
      })
      .andWhere('account.deleted_at IS NULL')
      .andWhere('(account.expires_at IS NULL OR account.expires_at > CURRENT_TIMESTAMP)')
      .getOne();

    if (!conversation) {
      throw new Error('Marketplace account is not connected.');
    }

    const marketplaceCode =
      conversation.marketplaceAccount.marketplace.marketplaceCode;

    const credentials = await credentialsRepository
      .createQueryBuilder('credentials')
      .where('credentials.marketplace_account_id = :marketplaceAccountId', {
        marketplaceAccountId: conversation.marketplaceAccountId,
      })
      .andWhere(
        '(credentials.access_token_expires_at IS NULL OR credentials.access_token_expires_at > CURRENT_TIMESTAMP)',
      )
      .getOne();

    if (!credentials) {
      throw new Error('Marketplace credential is missing.');
    }

    const accessToken = decryptMarketplaceSecret(credentials.accessTokenEncrypted);

    if (!accessToken) {
      throw new Error('Marketplace seller access token is missing.');
    }

    if (message) {
      message.deliveryStatus = 'QUEUED';
      message.errorMessage = null;
      message.queuedAt = new Date();
      message.failedAt = null;
      message = await messageRepository.save(message);
    } else {
      const queuedMessage = messageRepository.create({
        id: randomUUID(),
        tenantId,
        conversationId: conversation.id,
        externalMessageId: null,
        clientMessageId,
        direction: 'OUTBOUND',
        senderType: input.senderType || 'STAFF',
        senderUserId: input.senderType === 'AI' ? null : input.senderUserId || null,
        messageType: 'TEXT',
        textContent: text,
        contentJson: input.aiResponseRunId
          ? { aiResponseRunId: input.aiResponseRunId }
          : {},
        rawPayload: {},
        deliveryStatus: 'QUEUED',
        moderationStatus: 'NOT_CHECKED',
        errorMessage: null,
        queuedAt: new Date(),
        sentAt: null,
        failedAt: null,
        externalCreatedAt: null,
      });
      message = await messageRepository.save(queuedMessage);
    }

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
