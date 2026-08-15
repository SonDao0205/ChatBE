import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../config/database';
import { AiBackendService } from './aiBackend.service';
import { customerAiProfileService } from './customerAiProfile.service';
import { MarketplaceMessageSenderService } from './marketplaceMessageSender.service';
import { emitConversationUpdated } from './socket.service';

type CareCandidate = {
  id: string;
  tenant_id: string;
  marketplace_customer_id: string;
  marketplace_account_id: string;
  conversation_id: string;
  external_order_id: string;
  products: string;
  task_id: string | null;
  delivered_at: Date;
  external_shop_name: string;
};

const positivePattern = /hài lòng|rất tốt|dùng ổn|ưng|ok|tuyệt|đã nhận.*ổn/i;
const negativePattern = /không hài lòng|lỗi|hỏng|sai (?:màu|size|sản phẩm)|thiếu hàng|kém|đổi hàng|trả hàng|hoàn tiền/i;
const vietnamOffsetMs = 7 * 60 * 60 * 1000;

export class PostPurchaseCareService {
  private readonly sender = new MarketplaceMessageSenderService();
  private readonly aiBackend = new AiBackendService();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (this.timer || process.env.POST_PURCHASE_CARE_ENABLED === 'false') return;
    this.scheduleNextDailyScan();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNextDailyScan() {
    const now = new Date();
    const vietnamNow = new Date(now.getTime() + vietnamOffsetMs);
    let nextRun = Date.UTC(
      vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth(), vietnamNow.getUTCDate(), 1,
    );
    if (nextRun <= now.getTime()) nextRun += 24 * 60 * 60 * 1000;
    this.timer = setTimeout(async () => {
      await this.scanSafely();
      this.timer = null;
      this.scheduleNextDailyScan();
    }, nextRun - now.getTime());
    console.log('[post-purchase-care] next daily scan scheduled', {
      localTime: new Date(nextRun).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    });
  }

  async scan() {
    if (this.running || !AppDataSource.isInitialized) return;
    this.running = true;
    try {
      const rows = await AppDataSource.query<CareCandidate[]>(
        `SELECT order_record.id, order_record.tenant_id,
                order_record.marketplace_customer_id, order_record.marketplace_account_id,
                conversation.id AS conversation_id, order_record.external_order_id,
                care_task.id AS task_id,
                COALESCE(delivery.delivered_at, order_record.external_updated_at) AS delivered_at,
                account.external_shop_name,
                COALESCE(STRING_AGG(DISTINCT item.product_name_snapshot, ', '), '') AS products
         FROM orders order_record
         JOIN marketplace_accounts account ON account.id=order_record.marketplace_account_id
          AND account.tenant_id=order_record.tenant_id
         JOIN LATERAL (
           SELECT id FROM conversations
           WHERE tenant_id=order_record.tenant_id
             AND marketplace_account_id=order_record.marketplace_account_id
             AND marketplace_customer_id=order_record.marketplace_customer_id
           ORDER BY updated_at DESC LIMIT 1
         ) conversation ON TRUE
         LEFT JOIN LATERAL (
           SELECT MIN(history.occurred_at) AS delivered_at
           FROM order_status_history history
           WHERE history.tenant_id=order_record.tenant_id
             AND history.order_id=order_record.id
             AND history.to_canonical_status='DELIVERED'
         ) delivery ON TRUE
         LEFT JOIN order_items item ON item.order_id=order_record.id
          AND item.tenant_id=order_record.tenant_id
         LEFT JOIN post_purchase_care_tasks care_task
           ON care_task.tenant_id=order_record.tenant_id
          AND care_task.order_id=order_record.id
          AND care_task.care_type='SATISFACTION_CHECK'
         WHERE order_record.canonical_status='DELIVERED'
           AND order_record.last_synced_at IS NOT NULL
           AND order_record.marketplace_customer_id IS NOT NULL
           AND (COALESCE(delivery.delivered_at, order_record.external_updated_at)
                  AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
                 = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 2
           AND (care_task.id IS NULL OR care_task.status='FAILED')
         GROUP BY order_record.id, conversation.id, care_task.id,
                  delivery.delivered_at, account.external_shop_name
         ORDER BY COALESCE(delivery.delivered_at, order_record.external_updated_at) ASC
         LIMIT 100`,
      );
      console.log('[post-purchase-care] daily scan completed', { eligibleOrders: rows.length });
      for (const row of rows) await this.createAndSend(row);
    } finally {
      this.running = false;
    }
  }

  async scanSafely() {
    try {
      await this.scan();
    } catch (error) {
      console.error('[post-purchase-care] scan failed', error);
    }
  }

  private async createAndSend(row: CareCandidate) {
    const taskId = row.task_id || randomUUID();
    const productText = row.products || 'sản phẩm mình đã nhận';
    const fallbackText = `Anh/chị ơi, ${productText} có vấn đề gì không ạ; nếu có, anh/chị inbox cho shop, bên em sẽ hỗ trợ mình ạ.`;
    let text = fallbackText;
    try {
      text = await this.generateCareMessage(row, taskId, fallbackText);
    } catch (error) {
      console.error('[post-purchase-care] AI generation failed; using safe fallback', {
        orderId: row.external_order_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let ready = true;
    if (row.task_id) {
      await AppDataSource.query(
        `UPDATE post_purchase_care_tasks
         SET status='READY', scheduled_at=CURRENT_TIMESTAMP, ai_generated_message=$1,
             outcome_note=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE id=$2 AND tenant_id=$3 AND status='FAILED'`,
        [text, taskId, row.tenant_id],
      );
    } else {
      const inserted = await AppDataSource.query<Array<{ id: string }>>(
        `INSERT INTO post_purchase_care_tasks (
           id, tenant_id, order_id, marketplace_customer_id, conversation_id,
           care_type, status, scheduled_at, ai_generated_message, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'SATISFACTION_CHECK','READY',CURRENT_TIMESTAMP,$6,
                   CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, order_id, care_type) DO NOTHING RETURNING id`,
        [taskId, row.tenant_id, row.id, row.marketplace_customer_id, row.conversation_id, text],
      );
      ready = Boolean(inserted[0]);
    }
    if (!ready) return;

    try {
      await this.sender.sendSellerMessage({
        tenantId: row.tenant_id,
        conversationId: row.conversation_id,
        text,
        senderType: 'AI',
        idempotencyKey: `post-purchase-${row.id}`,
      });
      await AppDataSource.query(
        `UPDATE post_purchase_care_tasks SET status='IN_PROGRESS', updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND tenant_id=$2`,
        [taskId, row.tenant_id],
      );
    } catch (error) {
      await AppDataSource.query(
        `UPDATE post_purchase_care_tasks SET status='FAILED', outcome_note=$1,
          updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND tenant_id=$3`,
        [error instanceof Error ? error.message.slice(0, 1000) : 'Cannot send follow-up', taskId, row.tenant_id],
      );
    }
  }

  private async generateCareMessage(row: CareCandidate, taskId: string, fallbackText: string) {
    const profile = await customerAiProfileService.getCompactSnapshot(
      row.tenant_id, row.marketplace_customer_id,
    );
    const recentMessages = await AppDataSource.query<
      Array<{
        sender_type: 'CUSTOMER' | 'STAFF' | 'AI' | 'SYSTEM' | 'SHOP';
        text_content: string;
      }>
    >(
      `SELECT sender_type, text_content FROM (
         SELECT sender_type, text_content, created_at
         FROM messages WHERE tenant_id=$1 AND conversation_id=$2
           AND text_content IS NOT NULL
         ORDER BY created_at DESC LIMIT 8
       ) recent ORDER BY created_at ASC`,
      [row.tenant_id, row.conversation_id],
    );
    const instruction = [
      'Đây là tác vụ chăm sóc hậu mãi chủ động, không phải câu hỏi của khách hàng.',
      `Đơn ${row.external_order_id} gồm ${row.products || 'sản phẩm khách đã mua'} đã hoàn thành được 2 ngày.`,
      'Chỉ viết đúng một câu tiếng Việt ngắn gọn để hỏi thăm sau khi khách đã sử dụng sản phẩm một thời gian.',
      'Câu trả lời phải theo ý: “Anh/chị ơi, sản phẩm <tên sản phẩm> có vấn đề gì không ạ; nếu có, anh/chị inbox cho shop, bên em sẽ hỗ trợ mình ạ.”',
      'Phải nhắc đúng tên sản phẩm trong đơn.',
      'Không cảm ơn khách đã đặt hàng hoặc đã mua hàng vì TikTok Shop đã gửi mẫu cảm ơn riêng.',
      'Không chào bán, không gợi ý mua thêm, không tạo ưu đãi, không giải thích và không nhắc đây là nội dung do AI tạo.',
    ].join(' ');
    const response = await this.aiBackend.generateStateless(row.tenant_id, {
      request_id: taskId,
      conversation_id: row.conversation_id,
      trigger_message_id: row.id,
      marketplace_account_id: row.marketplace_account_id,
      customer_id: row.marketplace_customer_id,
      message: instruction,
      recent_messages: recentMessages.map((message) => ({
        sender_type: message.sender_type,
        text_content: message.text_content.slice(0, 1000),
      })),
      shop_context: {
        business_name: row.external_shop_name,
        default_language: 'vi',
        brand_voice: 'Ngắn gọn, gần gũi và chu đáo',
        max_response_characters: 300,
      },
      customer_profile: profile,
      response_strategy: {
        code: 'POST_PURCHASE_RETENTION',
        goal: 'Chỉ hỏi thăm ngắn gọn tình trạng sản phẩm sau một thời gian sử dụng.',
        allow_upsell: false,
        rules: [
          'Không thúc ép khách mua thêm.',
          'Không hứa chính sách hoặc ưu đãi chưa được xác thực.',
          'Không cảm ơn khách đã đặt hàng.',
          'Chỉ gửi đúng một câu hỏi thăm ngắn gọn và nhắc tên sản phẩm.',
        ],
      },
      facts: {
        completed_order: {
          external_order_id: row.external_order_id,
          products: row.products,
          delivered_at: row.delivered_at,
        },
      },
      sources: [],
      previous_ai_text: null,
    });
    return response.decision === 'AUTO_REPLY' && response.reply?.trim()
      ? response.reply.trim().slice(0, 1000)
      : fallbackText;
  }

  async recordCustomerReply(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    text: string;
  }) {
    const tasks = await AppDataSource.query<Array<{ id: string }>>(
      `SELECT id FROM post_purchase_care_tasks
       WHERE tenant_id=$1 AND conversation_id=$2 AND care_type='SATISFACTION_CHECK'
         AND status='IN_PROGRESS' ORDER BY created_at DESC LIMIT 1`,
      [input.tenantId, input.conversationId],
    );
    if (!tasks[0]) return false;
    const negative = negativePattern.test(input.text);
    const positive = !negative && positivePattern.test(input.text);
    if (!negative && !positive) return false;
    await AppDataSource.query(
      `UPDATE post_purchase_care_tasks SET status='COMPLETED', outcome_code=$1,
       outcome_note=$2, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$3`,
      [negative ? 'DISSATISFIED' : 'SATISFIED', `Customer message: ${input.messageId}`, tasks[0].id],
    );
    if (negative) {
      await AppDataSource.transaction(async (manager) => {
        await manager.query(
          `UPDATE conversations SET ai_mode='HUMAN_ONLY', priority='HIGH', updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND tenant_id=$2`,
          [input.conversationId, input.tenantId],
        );
        await manager.query(
          `INSERT INTO human_handoffs (id, tenant_id, conversation_id, reason_code,
           reason_text, priority, status, requested_at)
           SELECT $1,$2,$3,'POST_PURCHASE_DISSATISFIED',$4,'HIGH','REQUESTED',CURRENT_TIMESTAMP
           WHERE NOT EXISTS (SELECT 1 FROM human_handoffs WHERE tenant_id=$2
             AND conversation_id=$3 AND status IN ('REQUESTED','NOTIFIED','ACCEPTED'))`,
          [randomUUID(), input.tenantId, input.conversationId,
            'Khách phản hồi không hài lòng sau khi nhận hàng. Cần nhân viên xử lý.'],
        );
      });
      emitConversationUpdated(input.conversationId, {
        conversationId: input.conversationId,
        aiMode: 'HUMAN_ONLY',
        handoff: {
          reasonCode: 'POST_PURCHASE_DISSATISFIED',
          reasonText: 'Khách không hài lòng sau mua hàng.',
        },
      });
    }
    return negative;
  }
}

export const postPurchaseCareService = new PostPurchaseCareService();
