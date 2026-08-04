import { compactAiFacts } from '../src/service/aiFactsCompactor';

describe('compactAiFacts', () => {
  it('keeps normalized product color, size and live inventory facts', () => {
    const result = compactAiFacts({
      product: {
        query: 'áo khoác màu đen size M',
        matches: [{
          product_id: 'product-a',
          product_name: 'Áo khoác',
          secret: 'must-not-leak',
          variants: [{
            variant_name: 'Đen / M', seller_sku: 'AK-DEN-M', color: 'Đen', size: 'M',
            price: '250000', currency: 'VND', available_stock: 12, raw_payload: { hidden: true },
          }],
        }],
      },
    });
    const product = (result.product as { matches: Array<Record<string, unknown>> }).matches[0];
    const variant = (product.variants as Array<Record<string, unknown>>)[0];
    expect(variant).toMatchObject({ color: 'Đen', size: 'M', available_stock: 12 });
    expect(product).not.toHaveProperty('secret');
    expect(variant).not.toHaveProperty('raw_payload');
  });

  it('removes internal order ids and caps customer history', () => {
    const result = compactAiFacts({
      order: { id: 'internal-id', external_order_id: 'LZD-1', canonical_status: 'PAID' },
      customer_history: Array.from({ length: 9 }, (_, index) => ({
        id: `internal-${index}`,
        external_order_id: `LZD-${index}`,
        canonical_status: 'DELIVERED',
      })),
    });
    expect(result.order).not.toHaveProperty('id');
    expect(result.customer_history).toHaveLength(5);
  });
});
