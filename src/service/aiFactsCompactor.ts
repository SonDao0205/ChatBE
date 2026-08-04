const MAX_PRODUCTS = 5;
const MAX_VARIANTS_PER_PRODUCT = 8;
const MAX_ORDER_MATCHES = 3;
const MAX_HISTORY = 5;
const MAX_FACT_CHARACTERS = 12_000;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function withoutNulls(value: Record<string, unknown>, allowed: string[]) {
  return Object.fromEntries(
    allowed
      .filter((key) => value[key] !== null && value[key] !== undefined && value[key] !== '')
      .map((key) => [key, value[key]]),
  );
}

function compactProduct(value: unknown) {
  const product = objectValue(value);
  if (!product) return null;
  const variants = Array.isArray(product.variants)
    ? product.variants.slice(0, MAX_VARIANTS_PER_PRODUCT).map((item) => {
      const variant = objectValue(item) || {};
      return withoutNulls(variant, [
        'variant_name', 'seller_sku', 'color', 'size',
        'price', 'currency', 'available_stock',
      ]);
    })
    : [];
  return {
    ...withoutNulls(product, ['product_id', 'product_name', 'brand_name']),
    variants,
  };
}

function compactOrder(value: unknown) {
  const order = objectValue(value);
  if (!order) return value;
  if (Array.isArray(order.matches)) {
    return {
      matches: order.matches.slice(0, MAX_ORDER_MATCHES).map((item) => {
        const row = objectValue(item) || {};
        return withoutNulls(row, [
          'external_order_id', 'canonical_status', 'payment_status',
          'refund_status', 'total_amount', 'currency', 'external_created_at',
          'tracking_number', 'shipping_provider', 'shipping_status',
        ]);
      }),
    };
  }
  return withoutNulls(order, [
    'external_order_id', 'canonical_status', 'payment_status', 'refund_status',
    'total_amount', 'currency', 'external_created_at', 'tracking_number',
    'shipping_provider', 'shipping_status', 'shipped_at', 'delivered_at',
  ]);
}

export function compactAiFacts(facts: Record<string, unknown>) {
  const compact: Record<string, unknown> = {};
  if (facts.order) compact.order = compactOrder(facts.order);
  if (facts.shipment) {
    compact.shipment = withoutNulls(objectValue(facts.shipment) || {}, [
      'tracking_number', 'shipping_provider', 'canonical_status',
      'shipped_at', 'delivered_at',
    ]);
  }
  if (Array.isArray(facts.customer_history)) {
    compact.customer_history = facts.customer_history.slice(0, MAX_HISTORY)
      .map((item) => compactOrder(item));
  }
  const product = objectValue(facts.product);
  if (product && Array.isArray(product.matches)) {
    compact.product = {
      query: String(product.query || '').slice(0, 500),
      matches: product.matches.slice(0, MAX_PRODUCTS)
        .map(compactProduct)
        .filter(Boolean),
    };
  }
  for (const [key, value] of Object.entries(facts)) {
    if (!(key in compact) && !['order', 'shipment', 'customer_history', 'product'].includes(key)) {
      compact[key] = value;
    }
  }
  if (JSON.stringify(compact).length <= MAX_FACT_CHARACTERS) return compact;
  const compactProductFacts = objectValue(compact.product);
  if (compactProductFacts && Array.isArray(compactProductFacts.matches)) {
    compactProductFacts.matches = compactProductFacts.matches.slice(0, 3).map((item) => {
      const productItem = objectValue(item) || {};
      return {
        ...productItem,
        variants: Array.isArray(productItem.variants) ? productItem.variants.slice(0, 4) : [],
      };
    });
  }
  return compact;
}
