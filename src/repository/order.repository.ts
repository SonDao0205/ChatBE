import { AppDataSource } from '../config/database';

export class OrderRepository {
  findConversationOrders(input: {
    tenantId: string;
    marketplaceAccountId: string;
    marketplaceCustomerId: string;
  }) {
    return AppDataSource.query(
      `
      SELECT
        order_record.id,
        order_record.external_order_id AS externalOrderId,
        order_record.canonical_status AS canonicalStatus,
        order_record.payment_status AS paymentStatus,
        order_record.refund_status AS refundStatus,
        order_record.currency,
        CAST(order_record.total_amount AS CHAR) AS totalAmount,
        order_record.external_created_at AS externalCreatedAt,
        marketplace.marketplace_name AS channelName,
        COALESCE(
          GROUP_CONCAT(
            CONCAT(
              order_item.product_name_snapshot,
              IF(order_item.quantity > 1, CONCAT(' x', order_item.quantity), '')
            )
            ORDER BY order_item.created_at ASC
            SEPARATOR ', '
          ),
          ''
        ) AS items
      FROM orders order_record
      JOIN marketplace_accounts account
        ON account.id = order_record.marketplace_account_id
      JOIN marketplaces marketplace
        ON marketplace.id = account.marketplace_id
      LEFT JOIN order_items order_item
        ON order_item.order_id = order_record.id
        AND order_item.tenant_id = order_record.tenant_id
      WHERE order_record.tenant_id = ?
        AND order_record.marketplace_account_id = ?
        AND order_record.marketplace_customer_id = ?
        AND order_record.deleted_at IS NULL
      GROUP BY
        order_record.id,
        order_record.external_order_id,
        order_record.canonical_status,
        order_record.payment_status,
        order_record.refund_status,
        order_record.currency,
        order_record.total_amount,
        order_record.external_created_at,
        marketplace.marketplace_name
      ORDER BY order_record.external_created_at DESC
      LIMIT 20
      `,
      [
        input.tenantId,
        input.marketplaceAccountId,
        input.marketplaceCustomerId,
      ],
    );
  }
}
