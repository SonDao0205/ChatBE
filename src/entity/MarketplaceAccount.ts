import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { Conversation } from './Conversation';
import { Marketplace } from './Marketplace';
import { MarketplaceCredentials } from './MarketplaceCredentials';
import { MarketplaceCustomer } from './MarketplaceCustomer';
import { WebhookInbox } from './WebhookInbox';

@Entity('marketplace_accounts')
export class MarketplaceAccount {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ name: 'marketplace_id', type: 'char', length: 36 })
  marketplaceId!: string;

  @Column({ name: 'external_account_id', type: 'varchar', length: 200 })
  externalAccountId!: string;

  @Column({ name: 'shop_cipher', type: 'varchar', length: 255, nullable: true })
  shopCipher!: string | null;

  @Column({ name: 'external_shop_name', type: 'varchar', length: 255 })
  externalShopName!: string;

  @Column({ name: 'site_id', type: 'varchar', length: 10 })
  siteId!: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'timezone_name', type: 'varchar', length: 64 })
  timezoneName!: string;

  @Column({ name: 'connection_status', type: 'varchar', length: 20 })
  connectionStatus!: string;

  @ManyToOne(() => Marketplace, (marketplace) => marketplace.marketplaceAccounts)
  @JoinColumn({ name: 'marketplace_id' })
  marketplace!: Marketplace;

  @OneToMany(() => MarketplaceCustomer, (customer) => customer.marketplaceAccount)
  marketplaceCustomers!: MarketplaceCustomer[];

  @OneToMany(() => Conversation, (conversation) => conversation.marketplaceAccount)
  conversations!: Conversation[];

  @OneToMany(() => MarketplaceCredentials, (credentials) => credentials.marketplaceAccount)
  credentials!: MarketplaceCredentials[];

  @OneToMany(() => WebhookInbox, (webhookInbox) => webhookInbox.marketplaceAccount)
  webhookInboxItems!: WebhookInbox[];
}
