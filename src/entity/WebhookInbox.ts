import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MarketplaceAccount } from './MarketplaceAccount';

@Entity('webhook_inbox')
export class WebhookInbox {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ name: 'marketplace_account_id', type: 'char', length: 36 })
  marketplaceAccountId!: string;

  @Column({ name: 'external_event_id', type: 'varchar', length: 200 })
  externalEventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType!: string;

  @Column({ name: 'signature_valid', type: 'boolean' })
  signatureValid!: boolean;

  @Column({ name: 'headers_json', type: 'jsonb' })
  headersJson!: Record<string, unknown>;

  @Column({ name: 'payload_json', type: 'jsonb' })
  payloadJson!: Record<string, unknown>;

  @Column({ name: 'processing_status', type: 'varchar', length: 20 })
  processingStatus!: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DEAD';

  @Column({ name: 'attempt_count', type: 'int' })
  attemptCount!: number;

  @Column({ name: 'received_at', type: 'timestamptz', precision: 3 })
  receivedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', precision: 3, nullable: true })
  processedAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @ManyToOne(() => MarketplaceAccount, (marketplaceAccount) => marketplaceAccount.webhookInboxItems)
  @JoinColumn({ name: 'marketplace_account_id' })
  marketplaceAccount!: MarketplaceAccount;
}
