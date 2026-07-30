import { AppDataSource } from '../config/database';
import { MarketplaceCustomer } from '../entity/MarketplaceCustomer';

export class MarketplaceCustomerRepository {
  private readonly repository = AppDataSource.getRepository(MarketplaceCustomer);

  findByTenantAccountAndExternalCustomer(input: {
    tenantId: string;
    marketplaceAccountId: string;
    externalCustomerId: string;
  }) {
    return this.repository.findOneBy({
      tenantId: input.tenantId,
      marketplaceAccountId: input.marketplaceAccountId,
      externalCustomerId: input.externalCustomerId,
    });
  }

  save(customer: Partial<MarketplaceCustomer>) {
    return this.repository.save(customer);
  }
}
