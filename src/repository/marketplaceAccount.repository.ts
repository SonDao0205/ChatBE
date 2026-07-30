import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { AppDataSource } from '../config/database';
import { MarketplaceAccount } from '../entity/MarketplaceAccount';

export function onlyLinkedMarketplaceAccount<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  accountAlias = 'account',
  credentialsAlias = 'credentials',
) {
  return query
    .innerJoin(`${accountAlias}.credentials`, credentialsAlias)
    .andWhere(`${accountAlias}.connection_status = :connectedStatus`, {
      connectedStatus: 'CONNECTED',
    })
    .andWhere(`${accountAlias}.deleted_at IS NULL`);
}

export function onlyConnectedMarketplaceAccount<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  accountAlias = 'account',
  credentialsAlias = 'credentials',
) {
  return onlyLinkedMarketplaceAccount(query, accountAlias, credentialsAlias)
    .andWhere(
      `(${accountAlias}.expires_at IS NULL OR ${accountAlias}.expires_at > UTC_TIMESTAMP(3))`,
    )
    .andWhere(
      `(${credentialsAlias}.access_token_expires_at IS NULL OR ${credentialsAlias}.access_token_expires_at > UTC_TIMESTAMP(3))`,
    );
}

export class MarketplaceAccountRepository {
  private readonly repository = AppDataSource.getRepository(MarketplaceAccount);

  findConnectedByMarketplaceAndExternalAccount(input: {
    marketplaceCode: string;
    externalAccountId: string;
  }) {
    const query = this.repository
      .createQueryBuilder('account')
      .innerJoin('account.marketplace', 'marketplace')
      .where('marketplace.marketplace_code = :marketplaceCode', {
        marketplaceCode: input.marketplaceCode,
      })
      .andWhere('account.external_account_id = :externalAccountId', {
        externalAccountId: input.externalAccountId,
      });

    return onlyConnectedMarketplaceAccount(query).getOne();
  }
}
