import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MarketplaceAccount } from './MarketplaceAccount';

@Entity('marketplace_credentials')
export class MarketplaceCredentials {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'marketplace_account_id', type: 'char', length: 36 })
  marketplaceAccountId!: string;

  @Column({ name: 'app_key', type: 'varchar', length: 150, nullable: true })
  appKey!: string | null;

  @Column({ name: 'access_token_encrypted', type: 'mediumtext' })
  accessTokenEncrypted!: string;

  @Column({ name: 'refresh_token_encrypted', type: 'mediumtext', nullable: true })
  refreshTokenEncrypted!: string | null;

  @Column({ name: 'signing_secret_encrypted', type: 'mediumtext', nullable: true })
  signingSecretEncrypted!: string | null;

  @Column({ name: 'scopes_json', type: 'json' })
  scopesJson!: unknown;

  @Column({ name: 'encryption_key_version', type: 'varchar', length: 30 })
  encryptionKeyVersion!: string;

  @Column({ name: 'access_token_expires_at', type: 'datetime', precision: 3, nullable: true })
  accessTokenExpiresAt!: Date | null;

  @Column({ name: 'refresh_token_expires_at', type: 'datetime', precision: 3, nullable: true })
  refreshTokenExpiresAt!: Date | null;

  @Column({ name: 'last_refreshed_at', type: 'datetime', precision: 3, nullable: true })
  lastRefreshedAt!: Date | null;

  @ManyToOne(() => MarketplaceAccount, (marketplaceAccount) => marketplaceAccount.credentials)
  @JoinColumn({ name: 'marketplace_account_id' })
  marketplaceAccount!: MarketplaceAccount;
}
