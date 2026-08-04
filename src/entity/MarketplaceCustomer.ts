import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { Conversation } from './Conversation';
import { MarketplaceAccount } from './MarketplaceAccount';

@Entity('marketplace_customers')
export class MarketplaceCustomer {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ name: 'marketplace_account_id', type: 'char', length: 36 })
  marketplaceAccountId!: string;

  @Column({ name: 'external_customer_id', type: 'varchar', length: 200 })
  externalCustomerId!: string;

  @Column({ name: 'external_im_user_id', type: 'varchar', length: 200, nullable: true })
  externalImUserId!: string | null;

  @Column({ name: 'display_name', type: 'varchar', length: 255, nullable: true })
  displayName!: string | null;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl!: string | null;

  @Column({ name: 'phone_masked', type: 'varchar', length: 100, nullable: true })
  phoneMasked!: string | null;

  @Column({ name: 'email_masked', type: 'varchar', length: 255, nullable: true })
  emailMasked!: string | null;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload!: Record<string, unknown>;

  @Column({ name: 'last_seen_at', type: 'timestamptz', precision: 3 })
  lastSeenAt!: Date;

  @ManyToOne(() => MarketplaceAccount, (marketplaceAccount) => marketplaceAccount.marketplaceCustomers)
  @JoinColumn({ name: 'marketplace_account_id' })
  marketplaceAccount!: MarketplaceAccount;

  @OneToMany(() => Conversation, (conversation) => conversation.marketplaceCustomer)
  conversations!: Conversation[];
}
