import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { AppDataSource } from '../config/database';
import { Conversation } from '../entity/Conversation';
import { MarketplaceAccount } from '../entity/MarketplaceAccount';
import { MarketplaceCustomer } from '../entity/MarketplaceCustomer';
import { Message } from '../entity/Message';
import { WebhookInbox } from '../entity/WebhookInbox';
import { emitConversationUpdated, emitMessageCreated } from './socket.service';
import { AiBackendService } from './aiBackend.service';

type MarketplaceCode = 'TIKTOK_SHOP' | 'LAZADA';
type MessageDirection = 'INBOUND' | 'OUTBOUND';
type SenderType = 'CUSTOMER' | 'SHOP';

type NormalizedMarketplaceMessage = {
  marketplaceCode: MarketplaceCode;
  externalAccountId: string;
  externalEventId: string;
  externalConversationId: string;
  externalMessageId: string;
  externalCustomerId: string;
  externalImUserId: string | null;
  customerName: string | null;
  avatarUrl: string | null;
  textContent: string;
  direction: MessageDirection;
  senderType: SenderType;
  messageType: string;
  deliveryStatus: 'RECEIVED' | 'SENT';
  externalCreatedAt: Date;
  rawPayload: Record<string, unknown>;
};

export class WebhookAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookAuthenticationError';
  }
}

export class WebhookIgnoredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookIgnoredError';
  }
}

const mockWebhookSecrets = {
  TIKTOK_SHOP: {
    appKey: process.env.TIKTOK_OAUTH_CLIENT_ID || 'omni-tiktok-local',
    appSecret:
      process.env.TIKTOK_OAUTH_CLIENT_SECRET || 'tiktok-local-secret-change-me',
  },
  LAZADA: {
    appKey: process.env.LAZADA_OAUTH_CLIENT_ID || 'omni-lazada-local',
    appSecret:
      process.env.LAZADA_OAUTH_CLIENT_SECRET || 'lazada-local-secret-change-me',
  },
};

function parseJsonObject(rawBody: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Webhook payload is not a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseJsonString(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    return jsonObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function compactHeaders(headers: IncomingHttpHeaders) {
  return {
    authorization: headers.authorization,
    'x-mock-app-key': headers['x-mock-app-key'],
    'x-mock-event-id': headers['x-mock-event-id'],
    'x-mock-marketplace': headers['x-mock-marketplace'],
    'content-type': headers['content-type'],
  };
}

export class MarketplaceWebhookService {
  private readonly aiBackendService = new AiBackendService();

  async receive(input: { rawBody: Buffer; headers: IncomingHttpHeaders }) {
    const marketplaceCode = this.getMarketplaceCode(input.headers);
    this.verifySignature(marketplaceCode, input.rawBody, input.headers);

    const payload = parseJsonObject(input.rawBody);
    const normalizedMessage = this.normalizeMessage(marketplaceCode, payload);

    const marketplaceAccount = await this.requireConnectedMarketplaceAccount(
      normalizedMessage.marketplaceCode,
      normalizedMessage.externalAccountId,
    );

    const webhookInbox = await this.findOrCreateWebhookInbox(
      marketplaceAccount,
      normalizedMessage,
      compactHeaders(input.headers),
    );

    if (webhookInbox.processingStatus === 'PROCESSED') {
      return;
    }

    try {
      webhookInbox.processingStatus = 'PROCESSING';
      webhookInbox.attemptCount += 1;
      webhookInbox.lastError = null;
      await AppDataSource.getRepository(WebhookInbox).save(webhookInbox);

      const stored = await this.upsertNormalizedMessage(
        marketplaceAccount,
        normalizedMessage,
      );

      webhookInbox.processingStatus = 'PROCESSED';
      webhookInbox.processedAt = new Date();
      await AppDataSource.getRepository(WebhookInbox).save(webhookInbox);

      if (
        stored &&
        stored.conversation.aiMode === 'AUTO' &&
        stored.message.direction === 'INBOUND' &&
        stored.message.senderType === 'CUSTOMER' &&
        stored.message.textContent?.trim()
      ) {
        void this.aiBackendService.processInboundMessage({
          tenantId: stored.message.tenantId,
          conversationId: stored.conversation.id,
          messageId: stored.message.id,
        }).catch((error: unknown) => {
          console.error('AI autopilot trigger failed:', error);
        });
      }
    } catch (error) {
      webhookInbox.processingStatus = 'FAILED';
      webhookInbox.lastError =
        error instanceof Error ? error.message : 'Cannot process webhook.';
      await AppDataSource.getRepository(WebhookInbox).save(webhookInbox);
      throw error;
    }
  }

  private getMarketplaceCode(headers: IncomingHttpHeaders): MarketplaceCode {
    const value = String(headers['x-mock-marketplace'] || '').toUpperCase();
    if (value !== 'TIKTOK_SHOP' && value !== 'LAZADA') {
      throw new WebhookAuthenticationError('Missing or invalid marketplace header.');
    }
    return value;
  }

  private verifySignature(
    marketplaceCode: MarketplaceCode,
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ) {
    const receivedSignature = String(headers.authorization || '');
    const secret = mockWebhookSecrets[marketplaceCode];

    if (!receivedSignature) {
      throw new WebhookAuthenticationError('Missing webhook signature.');
    }

    const expectedSignature = createHmac('sha256', secret.appSecret)
      .update(`${secret.appKey}${rawBody.toString('utf8')}`)
      .digest('hex');

    const receivedBuffer = Buffer.from(receivedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      throw new WebhookAuthenticationError('Invalid webhook signature.');
    }
  }

  private normalizeMessage(
    marketplaceCode: MarketplaceCode,
    payload: Record<string, unknown>,
  ): NormalizedMarketplaceMessage {
    if (marketplaceCode === 'TIKTOK_SHOP') {
      return this.normalizeTiktokMessage(payload);
    }
    return this.normalizeLazadaMessage(payload);
  }

  private normalizeTiktokMessage(
    payload: Record<string, unknown>,
  ): NormalizedMarketplaceMessage {
    const data = jsonObject(payload.data);
    const sender = jsonObject(data.sender);
    const content = parseJsonString(data.content);
    const senderRole = String(sender.role || '');
    const isCustomerMessage = senderRole === 'BUYER';
    const conversationId = String(data.conversation_id || '');
    const eventId = String(payload.tts_notification_id || '');
    const externalAccountId = String(payload.shop_id || '');
    const imUserId = String(sender.im_user_id || '');

    if (!eventId || !externalAccountId || !conversationId || !data.message_id) {
      throw new Error('Invalid TikTok Shop message webhook payload.');
    }

    return {
      marketplaceCode: 'TIKTOK_SHOP',
      externalAccountId,
      externalEventId: eventId,
      externalConversationId: conversationId,
      externalMessageId: String(data.message_id),
      externalCustomerId: isCustomerMessage
        ? imUserId
        : `customer_of_${conversationId}`,
      externalImUserId: isCustomerMessage ? imUserId : null,
      customerName:
        typeof sender.nickname === 'string' ? sender.nickname : null,
      avatarUrl: typeof sender.avatar === 'string' ? sender.avatar : null,
      textContent:
        typeof content.content === 'string' ? content.content : '',
      direction: isCustomerMessage ? 'INBOUND' : 'OUTBOUND',
      senderType: isCustomerMessage ? 'CUSTOMER' : 'SHOP',
      messageType: String(data.type || 'TEXT'),
      deliveryStatus: isCustomerMessage ? 'RECEIVED' : 'SENT',
      externalCreatedAt: new Date(Number(data.create_time) * 1000),
      rawPayload: payload,
    };
  }

  private normalizeLazadaMessage(
    payload: Record<string, unknown>,
  ): NormalizedMarketplaceMessage {
    const data = jsonObject(payload.data);
    const content = parseJsonString(data.content);
    const isCustomerMessage = Number(data.from_account_type) === 1;
    const externalAccountId = String(payload.seller_id || '');
    const conversationId = String(data.session_id || '');
    const eventId = String(payload.timestamp || data.message_id || '');

    if (!eventId || !externalAccountId || !conversationId || !data.message_id) {
      throw new Error('Invalid Lazada message webhook payload.');
    }

    return {
      marketplaceCode: 'LAZADA',
      externalAccountId,
      externalEventId: eventId,
      externalConversationId: conversationId,
      externalMessageId: String(data.message_id),
      externalCustomerId: isCustomerMessage
        ? String(data.from_account_id || '')
        : String(data.to_account_id || `customer_of_${conversationId}`),
      externalImUserId: isCustomerMessage
        ? String(data.from_account_id || '')
        : String(data.to_account_id || ''),
      customerName: null,
      avatarUrl: null,
      textContent: typeof content.txt === 'string' ? content.txt : '',
      direction: isCustomerMessage ? 'INBOUND' : 'OUTBOUND',
      senderType: isCustomerMessage ? 'CUSTOMER' : 'SHOP',
      messageType: 'TEXT',
      deliveryStatus: isCustomerMessage ? 'RECEIVED' : 'SENT',
      externalCreatedAt: new Date(Number(data.send_time)),
      rawPayload: payload,
    };
  }

  private async requireConnectedMarketplaceAccount(
    marketplaceCode: MarketplaceCode,
    externalAccountId: string,
  ) {
    const accountRepository = AppDataSource.getRepository(MarketplaceAccount);

    const account = await accountRepository
      .createQueryBuilder('account')
      .innerJoin('account.marketplace', 'marketplace')
      .innerJoin('account.credentials', 'credentials')
      .where('marketplace.marketplace_code = :marketplaceCode', {
        marketplaceCode,
      })
      .andWhere('account.external_account_id = :externalAccountId', {
        externalAccountId,
      })
      .andWhere('account.connection_status = :connectionStatus', {
        connectionStatus: 'CONNECTED',
      })
      .andWhere('account.deleted_at IS NULL')
      .andWhere('(account.expires_at IS NULL OR account.expires_at > CURRENT_TIMESTAMP)')
      .andWhere(
        '(credentials.access_token_expires_at IS NULL OR credentials.access_token_expires_at > CURRENT_TIMESTAMP)',
      )
      .getOne();

    if (!account) {
      throw new WebhookIgnoredError(
        'Marketplace account is not connected for this shop.',
      );
    }

    return account;
  }

  private async findOrCreateWebhookInbox(
    marketplaceAccount: MarketplaceAccount,
    normalizedMessage: NormalizedMarketplaceMessage,
    headersJson: Record<string, unknown>,
  ) {
    const repository = AppDataSource.getRepository(WebhookInbox);
    const existing = await repository.findOneBy({
      marketplaceAccountId: marketplaceAccount.id,
      externalEventId: normalizedMessage.externalEventId,
    });

    if (existing) return existing;

    return repository.save({
      id: randomUUID(),
      tenantId: marketplaceAccount.tenantId,
      marketplaceAccountId: marketplaceAccount.id,
      externalEventId: normalizedMessage.externalEventId,
      eventType: 'CHAT_MESSAGE',
      signatureValid: true,
      headersJson,
      payloadJson: normalizedMessage.rawPayload,
      processingStatus: 'RECEIVED',
      attemptCount: 0,
      receivedAt: new Date(),
      processedAt: null,
      lastError: null,
    });
  }

  private async upsertNormalizedMessage(
    marketplaceAccount: MarketplaceAccount,
    input: NormalizedMarketplaceMessage,
  ) {
    const tenantId = marketplaceAccount.tenantId;
    const customerRepository = AppDataSource.getRepository(MarketplaceCustomer);
    const conversationRepository = AppDataSource.getRepository(Conversation);
    const messageRepository = AppDataSource.getRepository(Message);

    let conversation = await conversationRepository.findOne({
      where: {
        tenantId,
        marketplaceAccountId: marketplaceAccount.id,
        externalConversationId: input.externalConversationId,
      },
      relations: {
        marketplaceCustomer: true,
      },
    });

    let customer: MarketplaceCustomer | null =
      conversation?.marketplaceCustomer ?? null;

    if (!customer) {
      customer = await customerRepository.findOneBy({
        tenantId,
        marketplaceAccountId: marketplaceAccount.id,
        externalCustomerId: input.externalCustomerId,
      });
    }

    if (!customer) {
      customer = await customerRepository.save({
        id: randomUUID(),
        tenantId,
        marketplaceAccountId: marketplaceAccount.id,
        externalCustomerId: input.externalCustomerId,
        externalImUserId: input.externalImUserId,
        displayName: input.customerName || input.externalCustomerId,
        avatarUrl: input.avatarUrl,
        phoneMasked: null,
        emailMasked: null,
        rawPayload: {},
        lastSeenAt: new Date(),
      });
    }

    if (!conversation) {
      conversation = await conversationRepository.save({
        id: randomUUID(),
        tenantId,
        marketplaceAccountId: marketplaceAccount.id,
        marketplaceCustomerId: customer.id,
        externalConversationId: input.externalConversationId,
        rawStatus: 'OPEN',
        internalStatus: 'OPEN',
        priority: 'NORMAL',
        unreadCount: 0,
        lastMessageId: null,
        lastMessagePreview: null,
        lastMessageAt: null,
        aiMode: 'AUTO',
        rawPayload: {},
      });
    }

    const existingMessage = await messageRepository.findOneBy({
      conversationId: conversation.id,
      externalMessageId: input.externalMessageId,
    });

    if (existingMessage) return null;

    const message = await messageRepository.save({
      id: randomUUID(),
      tenantId,
      conversationId: conversation.id,
      externalMessageId: input.externalMessageId,
      clientMessageId: null,
      direction: input.direction,
      senderType: input.senderType,
      senderUserId: null,
      messageType: input.messageType,
      textContent: input.textContent,
      contentJson: {},
      rawPayload: input.rawPayload,
      deliveryStatus: input.deliveryStatus,
      moderationStatus: 'NOT_CHECKED',
      errorMessage: null,
      queuedAt: null,
      sentAt: input.direction === 'OUTBOUND' ? input.externalCreatedAt : null,
      failedAt: null,
      externalCreatedAt: input.externalCreatedAt,
    });

    conversation.lastMessageId = message.id;
    conversation.lastMessagePreview = input.textContent;
    conversation.lastMessageAt = input.externalCreatedAt;

    if (input.direction === 'INBOUND') {
      conversation.unreadCount += 1;
    }

    await conversationRepository.save(conversation);

    emitMessageCreated(conversation.id, {
      conversationId: conversation.id,
      message,
    });
    emitConversationUpdated(conversation.id, {
      conversationId: conversation.id,
      conversation,
    });
    return { conversation, message };
  }
}
