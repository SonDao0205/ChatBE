import { qdrantShopIsolationFilter } from '../src/service/shopKnowledge.service';

describe('shop knowledge isolation', () => {
  it('always filters vectors by both tenant and marketplace shop', () => {
    expect(qdrantShopIsolationFilter('tenant-a', 'shop-b')).toEqual({
      must: [
        { key: 'tenant_id', match: { value: 'tenant-a' } },
        { key: 'marketplace_account_id', match: { value: 'shop-b' } },
      ],
    });
  });
});
