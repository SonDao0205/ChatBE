import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { MarketplaceAccount } from './MarketplaceAccount';

@Entity('marketplaces')
export class Marketplace {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'marketplace_code', type: 'varchar', length: 30 })
  marketplaceCode!: string;

  @Column({ name: 'marketplace_name', type: 'varchar', length: 100 })
  marketplaceName!: string;

  @Column({ name: 'adapter_code', type: 'varchar', length: 50 })
  adapterCode!: string;

  @Column({ name: 'mock_base_url', type: 'varchar', length: 500, nullable: true })
  mockBaseUrl!: string | null;

  @OneToMany(() => MarketplaceAccount, (marketplaceAccount) => marketplaceAccount.marketplace)
  marketplaceAccounts!: MarketplaceAccount[];
}
