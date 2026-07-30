import { AppDataSource } from '../config/database';
import { MarketplaceCredentials } from '../entity/MarketplaceCredentials';

export class MarketplaceCredentialRepository {
  private readonly repository = AppDataSource.getRepository(MarketplaceCredentials);

  findValidAccessTokenByMarketplaceAccountId(marketplaceAccountId: string) {
    return this.repository
      .createQueryBuilder('credentials')
      .where('credentials.marketplace_account_id = :marketplaceAccountId', {
        marketplaceAccountId,
      })
      .andWhere(
        '(credentials.access_token_expires_at IS NULL OR credentials.access_token_expires_at > UTC_TIMESTAMP(3))',
      )
      .getOne();
  }
}
