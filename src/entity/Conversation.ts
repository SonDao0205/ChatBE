import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { MarketplaceAccount } from './MarketplaceAccount';
import { MarketplaceCustomer } from './MarketplaceCustomer';
import { Message } from './Message';

@Entity('conversations')
export class Conversation {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ name: 'marketplace_account_id', type: 'char', length: 36 })
  marketplaceAccountId!: string;

  @Column({ name: 'marketplace_customer_id', type: 'char', length: 36 })
  marketplaceCustomerId!: string;

  @Column({ name: 'external_conversation_id', type: 'varchar', length: 200 })
  externalConversationId!: string;

  @Column({ name: 'raw_status', type: 'varchar', length: 100, nullable: true })
  rawStatus!: string | null;

  @Column({ name: 'internal_status', type: 'varchar', length: 30 })
  internalStatus!: string;

  @Column({ name: 'priority', type: 'varchar', length: 20 })
  priority!: string;

  @Column({ name: 'unread_count', type: 'int' })
  unreadCount!: number;

  @Column({ name: 'last_message_id', type: 'char', length: 36, nullable: true })
  lastMessageId!: string | null;

  @Column({ name: 'last_message_preview', type: 'varchar', length: 500, nullable: true })
  lastMessagePreview!: string | null;

  @Column({ name: 'last_message_at', type: 'timestamptz', precision: 3, nullable: true })
  lastMessageAt!: Date | null;

  @Column({ name: 'ai_mode', type: 'varchar', length: 20 })
  aiMode!: string;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload!: Record<string, unknown>;

  @ManyToOne(() => MarketplaceAccount, (marketplaceAccount) => marketplaceAccount.conversations)
  @JoinColumn({ name: 'marketplace_account_id' })
  marketplaceAccount!: MarketplaceAccount;

  @ManyToOne(() => MarketplaceCustomer, (marketplaceCustomer) => marketplaceCustomer.conversations)
  @JoinColumn({ name: 'marketplace_customer_id' })
  marketplaceCustomer!: MarketplaceCustomer;

  @OneToMany(() => Message, (message) => message.conversation)
  messages!: Message[];
}
