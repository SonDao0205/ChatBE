import { AppDataSource } from '../config/database';

function orderCandidates(message: string) {
  const tokens = message.match(/[A-Za-z0-9][A-Za-z0-9_-]{3,79}/g) || [];
  return [...new Set(tokens.map((token) => token.trim()))].slice(0, 8);
}

export class CustomerOrderFactsService {
  async load(input: {
    tenantId: string;
    marketplaceAccountId: string;
    customerId: string;
    message: string;
  }): Promise<Record<string, unknown>> {
    const facts: Record<string, unknown> = {};
    const candidates = orderCandidates(input.message);
    if (candidates.length > 0) {
      const rows = await AppDataSource.query<Array<Record<string, unknown>>>(
        `
          SELECT order_record.id, order_record.external_order_id,
                 order_record.canonical_status, order_record.payment_status,
                 order_record.refund_status, order_record.total_amount,
                 order_record.currency, order_record.external_created_at,
                 shipment.tracking_number, shipment.shipping_provider,
                 shipment.canonical_status AS shipping_status,
                 shipment.shipped_at, shipment.delivered_at
          FROM orders order_record
          LEFT JOIN LATERAL (
            SELECT tracking_number, shipping_provider, canonical_status,
                   shipped_at, delivered_at
            FROM shipments
            WHERE tenant_id = order_record.tenant_id
              AND order_id = order_record.id
            ORDER BY created_at DESC
            LIMIT 1
          ) shipment ON TRUE
          WHERE order_record.tenant_id = $1
            AND order_record.marketplace_account_id = $2
            AND order_record.marketplace_customer_id = $3
            AND LOWER(order_record.external_order_id) = ANY($4::text[])
            AND order_record.deleted_at IS NULL
            AND order_record.last_synced_at IS NOT NULL
          ORDER BY order_record.external_updated_at DESC
          LIMIT 1
        `,
        [
          input.tenantId,
          input.marketplaceAccountId,
          input.customerId,
          candidates.map((candidate) => candidate.toLowerCase()),
        ],
      );
      if (rows[0]) {
        const exact = { ...rows[0] };
        facts.order = exact;
        if (exact.tracking_number || exact.shipping_provider || exact.shipping_status) {
          facts.shipment = {
            tracking_number: exact.tracking_number,
            shipping_provider: exact.shipping_provider,
            canonical_status: exact.shipping_status,
            shipped_at: exact.shipped_at,
            delivered_at: exact.delivered_at,
          };
        }
      }
    }

    const orderIntent = /đơn(?:\s+hàng)?|vận chuyển|giao hàng|tracking/i.test(input.message);
    if (orderIntent && !facts.order) {
      const recentOrders = await this.loadRecent(input, 3);
      if (recentOrders.length > 0) facts.order = { matches: recentOrders };
    }
    if (/lịch sử|đã mua|mua trước/i.test(input.message)) {
      facts.customer_history = await this.loadRecent(input, 5);
    }
    return facts;
  }

  private loadRecent(input: {
    tenantId: string;
    marketplaceAccountId: string;
    customerId: string;
  }, limit: number) {
    return AppDataSource.query<Array<Record<string, unknown>>>(
      `
        SELECT order_record.external_order_id,
               order_record.canonical_status,
               order_record.payment_status,
               order_record.refund_status,
               order_record.total_amount,
               order_record.currency,
               order_record.external_created_at,
               shipment.tracking_number,
               shipment.shipping_provider,
               shipment.canonical_status AS shipping_status
        FROM orders order_record
        LEFT JOIN LATERAL (
          SELECT tracking_number, shipping_provider, canonical_status
          FROM shipments
          WHERE tenant_id = order_record.tenant_id
            AND order_id = order_record.id
          ORDER BY created_at DESC
          LIMIT 1
        ) shipment ON TRUE
        WHERE order_record.tenant_id = $1
          AND order_record.marketplace_account_id = $2
          AND order_record.marketplace_customer_id = $3
          AND order_record.deleted_at IS NULL
          AND order_record.last_synced_at IS NOT NULL
        ORDER BY order_record.external_created_at DESC
        LIMIT $4
      `,
      [input.tenantId, input.marketplaceAccountId, input.customerId, limit],
    );
  }
}

export const customerOrderFactsService = new CustomerOrderFactsService();
