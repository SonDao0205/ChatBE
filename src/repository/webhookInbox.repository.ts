import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../config/database';
import { MarketplaceAccount } from '../entity/MarketplaceAccount';
import { WebhookInbox } from '../entity/WebhookInbox';

export class WebhookInboxRepository {
  private readonly repository = AppDataSource.getRepository(WebhookInbox);

  async findOrCreate(input: {
    marketplaceAccount: MarketplaceAccount;
    externalEventId: string;
    headersJson: Record<string, unknown>;
    payloadJson: Record<string, unknown>;
  }) {
    const existing = await this.repository.findOneBy({
      marketplaceAccountId: input.marketplaceAccount.id,
      externalEventId: input.externalEventId,
    });

    if (existing) return existing;

    return this.repository.save({
      id: randomUUID(),
      tenantId: input.marketplaceAccount.tenantId,
      marketplaceAccountId: input.marketplaceAccount.id,
      externalEventId: input.externalEventId,
      eventType: 'CHAT_MESSAGE',
      signatureValid: true,
      headersJson: input.headersJson,
      payloadJson: input.payloadJson,
      processingStatus: 'RECEIVED',
      attemptCount: 0,
      receivedAt: new Date(),
      processedAt: null,
      lastError: null,
    });
  }

  save(webhookInbox: WebhookInbox) {
    return this.repository.save(webhookInbox);
  }
}
