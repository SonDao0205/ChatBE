const query = jest.fn();

jest.mock('../src/config/database', () => ({
  AppDataSource: { query },
}));

import { CustomerOrderFactsService } from '../src/service/customerOrderFacts.service';

describe('CustomerOrderFactsService isolation', () => {
  beforeEach(() => query.mockReset());

  it('scopes exact, recent and history order reads to tenant + shop + customer', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const service = new CustomerOrderFactsService();
    await service.load({
      tenantId: 'tenant-a',
      marketplaceAccountId: 'shop-a',
      customerId: 'customer-a',
      message: 'Kiểm tra đơn TTS-1001 và lịch sử đã mua',
    });

    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain('order_record.tenant_id = $1');
      expect(sql).toContain('order_record.marketplace_account_id = $2');
      expect(sql).toContain('order_record.marketplace_customer_id = $3');
      expect(params.slice(0, 3)).toEqual(['tenant-a', 'shop-a', 'customer-a']);
    }
  });

  it('returns only the exact customer order supplied by the isolated query', async () => {
    query.mockResolvedValueOnce([{
      external_order_id: 'TTS-1001',
      canonical_status: 'SHIPPED',
      tracking_number: 'TRACK-1',
      shipping_provider: 'J&T',
      shipping_status: 'IN_TRANSIT',
    }]);
    const service = new CustomerOrderFactsService();
    const facts = await service.load({
      tenantId: 'tenant-a',
      marketplaceAccountId: 'shop-a',
      customerId: 'customer-a',
      message: 'Đơn TTS-1001 đang ở đâu?',
    });
    expect((facts.order as Record<string, unknown>).external_order_id).toBe('TTS-1001');
    expect((facts.shipment as Record<string, unknown>).tracking_number).toBe('TRACK-1');
  });
});
