import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../config/database';
import { emitCustomerProfileUpdated } from './socket.service';
import { AiBackendService } from './aiBackend.service';

export type LeadPriority =
  | 'HOT_LEAD'
  | 'WARM_LEAD'
  | 'COLD_LEAD'
  | 'EXISTING_PRIORITY';

type ProfileRow = {
  id: string;
  tenant_id: string;
  marketplace_customer_id: string;
  profile_summary: string | null;
  features_json: Record<string, unknown> | string;
  profile_status: 'EMPTY' | 'PENDING' | 'READY' | 'FAILED';
  profile_version: number;
  message_count: number;
  lead_priority: LeadPriority | null;
  lead_priority_score: string | number | null;
  lead_priority_reason: string | null;
  lead_priority_computed_at: Date | null;
  lead_priority_override: boolean;
  last_computed_at: Date;
};

type MessageSignalRow = {
  id: string;
  text_content: string;
  sender_type: string;
  created_at: Date;
};

type OrderSignalRow = {
  id: string;
  canonical_status: string;
  total_amount: string;
  product_id: string | null;
  product_name: string | null;
  variant_name: string | null;
};

const priorityLabels: Record<LeadPriority, string> = {
  HOT_LEAD: 'Hot Lead',
  WARM_LEAD: 'Warm Lead',
  COLD_LEAD: 'Cold Lead',
  EXISTING_PRIORITY: 'Existing Priority',
};

const priorityDefinitions: Record<LeadPriority, string> = {
  HOT_LEAD:
    'Có nhu cầu cấp bách, có đủ tài chính và quyền quyết định mua hàng.',
  WARM_LEAD:
    'Đã quan tâm, chủ động tìm hiểu, đặt câu hỏi hoặc so sánh giá; chưa quyết định ngay vì còn cân nhắc tính năng hoặc chi phí.',
  COLD_LEAD:
    'Khách hàng mới, chưa rõ nhu cầu thực sự và đang đặt câu hỏi để có thêm thông tin.',
  EXISTING_PRIORITY: 'Đã mua hàng và có tiềm năng mua lại cao.',
};

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function unique(values: string[]) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function extractPreferences(messages: MessageSignalRow[]) {
  const customerText = messages
    .filter((item) => item.sender_type === 'CUSTOMER')
    .map((item) => item.text_content.toLowerCase())
    .join(' ');
  const colors = unique(
    ['đen', 'trắng', 'xám', 'đỏ', 'xanh', 'vàng', 'hồng', 'nâu', 'be'].filter(
      (value) => customerText.includes(value),
    ),
  );
  const sizes = unique(
    [...customerText.matchAll(/(?:size|cỡ)\s*(xs|s|m|l|xl|xxl|\d{2,3})\b/gi)].map(
      (match) => match[1].toUpperCase(),
    ),
  );
  const styles = unique(
    ['oversize', 'form rộng', 'ôm body', 'basic', 'thể thao', 'công sở'].filter(
      (value) => customerText.includes(value),
    ),
  );
  const priorities = unique(
    [
      ['giao nhanh', 'Giao nhanh'],
      ['giá rẻ', 'Giá tốt'],
      ['bền', 'Độ bền'],
      ['bảo hành', 'Bảo hành'],
      ['chất lượng', 'Chất lượng'],
    ]
      .filter(([needle]) => customerText.includes(needle))
      .map(([, label]) => label),
  );
  const budgetMatches = [...customerText.matchAll(/(\d+(?:[.,]\d+)?)\s*(triệu|tr|k|nghìn)/gi)];
  const budgets = budgetMatches.map((match) => {
    const amount = Number(match[1].replace(',', '.'));
    return /triệu|tr/i.test(match[2]) ? amount * 1_000_000 : amount * 1_000;
  });
  return {
    preferred_colors: colors,
    preferred_sizes: sizes,
    preferred_styles: styles,
    purchase_priorities: priorities,
    budget_range: budgets.length
      ? { min: Math.min(...budgets), max: Math.max(...budgets), currency: 'VND' }
      : { min: null, max: null, currency: 'VND' },
  };
}

export function classifyLead(messages: MessageSignalRow[], orders: OrderSignalRow[]) {
  const customerText = messages
    .filter((item) => item.sender_type === 'CUSTOMER')
    .map((item) => item.text_content.toLowerCase())
    .join(' ');
  const completedOrders = unique(
    orders
      .filter((order) => ['DELIVERED', 'COMPLETED'].includes(order.canonical_status))
      .map((order) => order.id),
  );
  const repurchaseSignal = /mua lại|đặt lại|lấy thêm|thêm một|như lần trước/.test(customerText);
  if (completedOrders.length >= 2 || (completedOrders.length >= 1 && repurchaseSignal)) {
    return {
      code: 'EXISTING_PRIORITY' as const,
      score: completedOrders.length >= 2 ? 0.94 : 0.86,
      reason: `Khách có ${completedOrders.length} đơn hoàn tất${
        repurchaseSignal ? ' và đang thể hiện nhu cầu mua lại' : ''
      }.`,
    };
  }
  const hotSignals = [
    /chốt|mua ngay|đặt hàng|thanh toán|giao gấp|nhận hôm nay|giữ hàng/,
    /còn hàng|còn size|còn màu/,
    /ngân sách|tầm \d+|khoảng \d+/,
  ].filter((pattern) => pattern.test(customerText)).length;
  if (hotSignals >= 2 || /chốt|mua ngay|giao gấp|thanh toán/.test(customerText)) {
    return {
      code: 'HOT_LEAD' as const,
      score: Math.min(0.96, 0.74 + hotSignals * 0.07),
      reason: 'Khách đang thể hiện ý định mua rõ ràng và cần hỗ trợ quyết định nhanh.',
    };
  }
  const warmSignals = [
    /giá|bao nhiêu|khuyến mãi|voucher/,
    /so sánh|khác nhau|tốt hơn/,
    /tính năng|chất liệu|size|màu|bảo hành/,
    /phù hợp|tư vấn|quan tâm/,
  ].filter((pattern) => pattern.test(customerText)).length;
  if (warmSignals > 0) {
    return {
      code: 'WARM_LEAD' as const,
      score: Math.min(0.9, 0.62 + warmSignals * 0.08),
      reason: 'Khách đang chủ động tìm hiểu sản phẩm, giá hoặc các tiêu chí phù hợp.',
    };
  }
  return {
    code: 'COLD_LEAD' as const,
    score: messages.length > 1 ? 0.7 : 0.58,
    reason: 'Khách còn mới và chưa thể hiện nhu cầu mua hàng đủ cụ thể.',
  };
}

function preferenceLabels(features: Record<string, unknown>) {
  const labels: string[] = [];
  const add = (prefix: string, value: unknown) => {
    if (Array.isArray(value)) {
      value.slice(0, 3).forEach((item) => labels.push(`${prefix}${String(item)}`));
    }
  };
  add('Màu ', features.preferred_colors);
  add('Size ', features.preferred_sizes);
  add('', features.preferred_styles);
  add('', features.purchase_priorities);
  return unique(labels).slice(0, 8);
}

function mergeProfileFeatures(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  const merged = { ...current, ...incoming };
  for (const key of [
    'preferred_colors',
    'preferred_sizes',
    'preferred_styles',
    'purchase_priorities',
  ]) {
    const previousValues = Array.isArray(current[key]) ? current[key] : [];
    const newValues = Array.isArray(incoming[key]) ? incoming[key] : [];
    merged[key] = unique([...previousValues, ...newValues].map(String)).slice(0, 20);
  }
  const incomingBudget = jsonObject(incoming.budget_range);
  const currentBudget = jsonObject(current.budget_range);
  if (incomingBudget.min == null && incomingBudget.max == null && Object.keys(currentBudget).length) {
    merged.budget_range = currentBudget;
  }
  return merged;
}

export class CustomerAiProfileService {
  private readonly aiBackend = new AiBackendService();
  async getByConversation(tenantId: string, conversationId: string) {
    const identities = await AppDataSource.query<
      Array<{
        marketplace_customer_id: string;
        marketplace_account_id: string;
      }>
    >(
      `SELECT marketplace_customer_id, marketplace_account_id
       FROM conversations WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [conversationId, tenantId],
    );
    const identity = identities[0];
    if (!identity) return null;
    return this.getView(
      tenantId,
      identity.marketplace_customer_id,
      identity.marketplace_account_id,
    );
  }

  async getCompactSnapshot(
    tenantId: string,
    marketplaceCustomerId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await AppDataSource.query<ProfileRow[]>(
      `SELECT * FROM customer_ai_profiles
       WHERE tenant_id = $1 AND marketplace_customer_id = $2 LIMIT 1`,
      [tenantId, marketplaceCustomerId],
    );
    const profile = rows[0];
    if (!profile) {
      return {
        status: 'EMPTY',
        profile_version: 0,
        summary: 'Khách còn mới và chưa thể hiện nhu cầu mua hàng đủ cụ thể.',
        preferences: {},
        lead_priority: {
          code: 'COLD_LEAD',
          score: 0.58,
          reason: 'Khách còn mới và chưa thể hiện nhu cầu mua hàng đủ cụ thể.',
        },
      };
    }
    const features = jsonObject(profile.features_json);
    return {
      status: profile.profile_status,
      profile_version: profile.profile_version,
      summary: profile.profile_summary,
      preferences: {
        preferred_colors: features.preferred_colors ?? [],
        preferred_sizes: features.preferred_sizes ?? [],
        preferred_styles: features.preferred_styles ?? [],
        purchase_priorities: features.purchase_priorities ?? [],
        budget_range: features.budget_range ?? null,
      },
      lead_priority: profile.lead_priority
        ? {
            code: profile.lead_priority,
            score: Number(profile.lead_priority_score ?? 0),
            reason: profile.lead_priority_reason,
          }
        : null,
    };
  }

  async refreshByConversation(tenantId: string, conversationId: string) {
    const rows = await AppDataSource.query<
      Array<{ marketplace_customer_id: string; marketplace_account_id: string }>
    >(
      `SELECT marketplace_customer_id, marketplace_account_id
       FROM conversations WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [conversationId, tenantId],
    );
    if (!rows[0]) return null;
    await this.refresh(
      tenantId,
      rows[0].marketplace_customer_id,
      rows[0].marketplace_account_id,
    );
    return this.getView(
      tenantId,
      rows[0].marketplace_customer_id,
      rows[0].marketplace_account_id,
    );
  }

  async overrideLeadPriority(
    tenantId: string,
    conversationId: string,
    priority: LeadPriority,
    reason: string,
  ) {
    const identities = await AppDataSource.query<
      Array<{ marketplace_customer_id: string; marketplace_account_id: string }>
    >(
      `SELECT marketplace_customer_id, marketplace_account_id
       FROM conversations WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [conversationId, tenantId],
    );
    const identity = identities[0];
    if (!identity) return null;
    const previous = await this.getCompactSnapshot(
      tenantId,
      identity.marketplace_customer_id,
    );
    const previousLead = (previous.lead_priority as { code?: string } | null)?.code ?? null;
    await AppDataSource.query(
      `UPDATE customer_ai_profiles SET
         lead_priority=$1, lead_priority_score=1,
         lead_priority_reason=$2, lead_priority_override=TRUE,
         lead_priority_override_reason=$2,
         lead_priority_computed_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$3 AND marketplace_customer_id=$4`,
      [priority, reason, tenantId, identity.marketplace_customer_id],
    );
    await AppDataSource.query(
      `INSERT INTO customer_lead_priority_history (
         id, tenant_id, marketplace_customer_id, previous_priority, new_priority,
         score, reason_text, evidence_json, source, model_version, created_at
       ) VALUES ($1,$2,$3,$4,$5,1,$6,'[]'::jsonb,'STAFF','manual-v1',CURRENT_TIMESTAMP)`,
      [randomUUID(), tenantId, identity.marketplace_customer_id, previousLead,
        priority, reason],
    );
    emitCustomerProfileUpdated(identity.marketplace_customer_id, {
      marketplaceCustomerId: identity.marketplace_customer_id,
      updatedAt: new Date().toISOString(),
    });
    return this.getView(
      tenantId,
      identity.marketplace_customer_id,
      identity.marketplace_account_id,
    );
  }

  async dismissRecommendation(tenantId: string, recommendationId: string) {
    const result = await AppDataSource.query(
      `UPDATE customer_ai_product_recommendations
       SET status='DISMISSED', updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'
       RETURNING id, marketplace_customer_id`,
      [recommendationId, tenantId],
    ) as Array<{ id: string; marketplace_customer_id: string }>;
    if (result[0]) {
      emitCustomerProfileUpdated(result[0].marketplace_customer_id, {
        marketplaceCustomerId: result[0].marketplace_customer_id,
        updatedAt: new Date().toISOString(),
      });
    }
    return Boolean(result[0]);
  }

  async refresh(
    tenantId: string,
    marketplaceCustomerId: string,
    marketplaceAccountId: string,
  ) {
    await AppDataSource.transaction(async (manager) => {
      const profileRows = await manager.query(
        `SELECT * FROM customer_ai_profiles
         WHERE tenant_id = $1 AND marketplace_customer_id = $2
         FOR UPDATE`,
        [tenantId, marketplaceCustomerId],
      ) as ProfileRow[];
      const existing = profileRows[0];
      const messages = (await manager.query(
        `SELECT message.id, message.text_content, message.sender_type,
                COALESCE(message.external_created_at, message.created_at) AS created_at
         FROM messages message
         JOIN conversations conversation ON conversation.id = message.conversation_id
          AND conversation.tenant_id = message.tenant_id
         WHERE message.tenant_id = $1
           AND conversation.marketplace_customer_id = $2
           AND message.text_content IS NOT NULL
         ORDER BY COALESCE(message.external_created_at, message.created_at) DESC
         LIMIT 100`,
        [tenantId, marketplaceCustomerId],
      )) as MessageSignalRow[];
      messages.reverse();
      if (messages.length === 0) return;
      const orders = (await manager.query(
        `SELECT order_record.id, order_record.canonical_status,
                order_record.total_amount::text, item.product_id,
                item.product_name_snapshot AS product_name,
                item.variant_name_snapshot AS variant_name
         FROM orders order_record
         LEFT JOIN order_items item ON item.order_id = order_record.id
          AND item.tenant_id = order_record.tenant_id
         WHERE order_record.tenant_id = $1
           AND order_record.marketplace_customer_id = $2
           AND order_record.deleted_at IS NULL
           AND order_record.last_synced_at IS NOT NULL
         ORDER BY order_record.external_created_at DESC NULLS LAST
         LIMIT 100`,
        [tenantId, marketplaceCustomerId],
      )) as OrderSignalRow[];
      let features = mergeProfileFeatures(
        jsonObject(existing?.features_json),
        extractPreferences(messages),
      );
      let detected = classifyLead(messages, orders);
      let modelVersion = 'customer-profile-rules-v1';
      try {
        const analysis = await this.aiBackend.analyzeCustomerProfile(tenantId, {
          customer_id: marketplaceCustomerId,
          existing_profile: {
            summary: existing?.profile_summary,
            features: jsonObject(existing?.features_json),
          },
          messages: messages.map((message) => ({
            id: message.id,
            sender_type: message.sender_type,
            text_content: message.text_content,
          })),
          recent_orders: orders.map((order) => ({ ...order })),
        });
        features = mergeProfileFeatures(features, analysis.features);
        detected = analysis.lead_priority;
        modelVersion = analysis.model_version;
      } catch (error) {
        console.warn('Customer profile AI unavailable; using verified rules.', {
          marketplaceCustomerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const lead = existing?.lead_priority_override && existing.lead_priority
        ? {
            code: existing.lead_priority,
            score: Number(existing.lead_priority_score ?? 1),
            reason: existing.lead_priority_reason || 'Nhân viên đã phân loại thủ công.',
          }
        : detected;
      const completedOrderRows = orders.filter((order) =>
        ['DELIVERED', 'COMPLETED'].includes(order.canonical_status),
      );
      const completedOrders = Array.from(
        new Map(completedOrderRows.map((order) => [order.id, order])).values(),
      );
      const totalValue = completedOrders.reduce(
        (sum, order) => sum + Number(order.total_amount || 0),
        0,
      );
      const labels = preferenceLabels(features);
      const summary = labels.length
        ? `Khách đang quan tâm: ${labels.join(', ')}. ${lead.reason}`
        : lead.reason;
      const profileId = existing?.id ?? randomUUID();
      const nextVersion = (existing?.profile_version ?? 0) + 1;
      await manager.query(
        `INSERT INTO customer_ai_profiles (
           id, tenant_id, marketplace_customer_id, profile_summary, features_json,
           order_count, conversation_count, lifetime_value, model_version,
           last_computed_at, profile_status, profile_version, message_count,
           last_summarized_message_id, last_summarized_at, summary_version,
           lead_priority, lead_priority_score, lead_priority_reason,
           lead_priority_evidence_json, lead_priority_computed_at,
           lead_priority_model_version, lead_priority_override,
           created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5::jsonb,$6,
           (SELECT COUNT(*) FROM conversations WHERE tenant_id=$2 AND marketplace_customer_id=$3),
           $7,$16,CURRENT_TIMESTAMP,'READY',$8,$9,$10,
           CURRENT_TIMESTAMP,'customer-profile-v1',$11,$12,$13,$14::jsonb,
           CURRENT_TIMESTAMP,'lead-rules-v1',COALESCE($15,FALSE),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
         )
         ON CONFLICT (marketplace_customer_id) DO UPDATE SET
           profile_summary=EXCLUDED.profile_summary,
           features_json=EXCLUDED.features_json,
           order_count=EXCLUDED.order_count,
           conversation_count=EXCLUDED.conversation_count,
           lifetime_value=EXCLUDED.lifetime_value,
           model_version=EXCLUDED.model_version,
           last_computed_at=EXCLUDED.last_computed_at,
           profile_status='READY', profile_version=EXCLUDED.profile_version,
           message_count=EXCLUDED.message_count,
           last_summarized_message_id=EXCLUDED.last_summarized_message_id,
           last_summarized_at=EXCLUDED.last_summarized_at,
           lead_priority=CASE WHEN customer_ai_profiles.lead_priority_override
             THEN customer_ai_profiles.lead_priority ELSE EXCLUDED.lead_priority END,
           lead_priority_score=CASE WHEN customer_ai_profiles.lead_priority_override
             THEN customer_ai_profiles.lead_priority_score ELSE EXCLUDED.lead_priority_score END,
           lead_priority_reason=CASE WHEN customer_ai_profiles.lead_priority_override
             THEN customer_ai_profiles.lead_priority_reason ELSE EXCLUDED.lead_priority_reason END,
           lead_priority_evidence_json=EXCLUDED.lead_priority_evidence_json,
           lead_priority_computed_at=EXCLUDED.lead_priority_computed_at,
           lead_priority_model_version=EXCLUDED.lead_priority_model_version,
           updated_at=CURRENT_TIMESTAMP`,
        [
          profileId, tenantId, marketplaceCustomerId, summary,
          JSON.stringify(features), completedOrders.length, totalValue, nextVersion,
          messages.length, messages.at(-1)!.id, lead.code, lead.score, lead.reason,
          JSON.stringify(messages.slice(-5).map((item) => item.id)),
          existing?.lead_priority_override ?? false, modelVersion,
        ],
      );
      await manager.query(
        `INSERT INTO customer_ai_profile_revisions (
           id, tenant_id, marketplace_customer_id, profile_version,
           previous_profile_json, new_profile_json, evidence_json,
           source, model_version, created_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'RULE_ENGINE',
                   $8,CURRENT_TIMESTAMP)
         ON CONFLICT (marketplace_customer_id, profile_version) DO NOTHING`,
        [
          randomUUID(), tenantId, marketplaceCustomerId, nextVersion,
          JSON.stringify(existing ?? {}),
          JSON.stringify({ summary, features, lead_priority: lead }),
          JSON.stringify(messages.slice(-20).map((item) => item.id)), modelVersion,
        ],
      );
      if (existing?.lead_priority !== lead.code) {
        await manager.query(
          `INSERT INTO customer_lead_priority_history (
             id, tenant_id, marketplace_customer_id, previous_priority,
             new_priority, score, reason_text, evidence_json, source,
             model_version, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'RULE_ENGINE',
                     'lead-rules-v1',CURRENT_TIMESTAMP)`,
          [randomUUID(), tenantId, marketplaceCustomerId,
            existing?.lead_priority ?? null, lead.code, lead.score, lead.reason,
            JSON.stringify(messages.slice(-5).map((item) => item.id))],
        );
      }
      await this.replaceRecommendations(
        manager,
        tenantId,
        marketplaceCustomerId,
        marketplaceAccountId,
        nextVersion,
        lead.code,
        features,
        completedOrderRows,
      );
    });
    emitCustomerProfileUpdated(marketplaceCustomerId, {
      marketplaceCustomerId,
      updatedAt: new Date().toISOString(),
    });
  }

  private async replaceRecommendations(
    manager: { query: (query: string, parameters?: unknown[]) => Promise<unknown> },
    tenantId: string,
    marketplaceCustomerId: string,
    marketplaceAccountId: string,
    profileVersion: number,
    leadPriority: LeadPriority,
    features: Record<string, unknown>,
    completedOrders: OrderSignalRow[],
  ) {
    await manager.query(
      `UPDATE customer_ai_product_recommendations
       SET status='EXPIRED', updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND marketplace_customer_id=$2 AND status='ACTIVE'`,
      [tenantId, marketplaceCustomerId],
    );
    if (leadPriority === 'COLD_LEAD') return;
    const purchasedIds = unique(
      completedOrders.map((order) => order.product_id ?? '').filter(Boolean),
    );
    const candidates = (await manager.query(
      `SELECT mp.product_id, mpv.product_variant_id AS variant_id,
              COALESCE(NULLIF(mp.external_title, ''), product.product_name) AS product_name,
              COALESCE(
                NULLIF(mpv.raw_payload->>'variant_name', ''),
                NULLIF(mpv.raw_payload->>'sku_name', ''),
                NULLIF(mpv.external_seller_sku, ''),
                variant.variant_name
              ) AS variant_name,
              mpv.external_price::text AS price,
              COALESCE(NULLIF(mpv.raw_payload->>'currency', ''), variant.currency) AS currency,
              mpv.external_stock AS available_stock
       FROM marketplace_products mp
       JOIN marketplace_product_variants mpv
         ON mpv.marketplace_product_id=mp.id AND mpv.tenant_id=mp.tenant_id
       JOIN products product ON product.id=mp.product_id AND product.tenant_id=mp.tenant_id
       JOIN product_variants variant
         ON variant.id=mpv.product_variant_id AND variant.tenant_id=mpv.tenant_id
       WHERE mp.tenant_id=$1 AND mp.marketplace_account_id=$2
         AND mp.sync_status='SYNCED' AND mp.last_synced_at IS NOT NULL
         AND mp.canonical_status='ACTIVE' AND mp.deleted_at IS NULL
         AND mpv.sync_status='SYNCED' AND mpv.last_synced_at IS NOT NULL
         AND mpv.canonical_status='ACTIVE' AND mpv.deleted_at IS NULL
         AND mpv.external_stock > 0
       ORDER BY mp.last_synced_at DESC, mpv.external_price ASC
       LIMIT 12`,
      [tenantId, marketplaceAccountId],
    )) as Array<{
      product_id: string;
      variant_id: string;
      product_name: string;
      variant_name: string | null;
    }>;
    const colors = Array.isArray(features.preferred_colors)
      ? features.preferred_colors.map(String)
      : [];
    const ranked = candidates
      .map((candidate) => {
        const text = `${candidate.product_name} ${candidate.variant_name ?? ''}`.toLowerCase();
        const preferenceBoost = colors.some((color) => text.includes(color.toLowerCase()))
          ? 0.08
          : 0;
        const purchased = purchasedIds.includes(candidate.product_id);
        const type = purchased && leadPriority === 'EXISTING_PRIORITY'
          ? 'REPURCHASE'
          : leadPriority === 'HOT_LEAD'
            ? 'UPSELL'
            : 'CROSS_SELL';
        return {
          ...candidate,
          type,
          score: Math.min(0.95, 0.72 + preferenceBoost + (purchased ? 0.08 : 0)),
          reason: purchased
            ? 'Khách đã mua sản phẩm này và có tiềm năng mua lại.'
            : colors.length
              ? `Phù hợp với màu sắc khách đang quan tâm: ${colors.join(', ')}.`
              : 'Phù hợp với nhu cầu và hồ sơ mua sắm gần đây của khách.',
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, leadPriority === 'HOT_LEAD' ? 2 : 3);
    for (const item of ranked) {
      await manager.query(
        `INSERT INTO customer_ai_product_recommendations (
           id, tenant_id, marketplace_customer_id, marketplace_account_id,
           product_id, variant_id, recommendation_type, score, reason_text,
           evidence_json, lead_priority_at_generation, profile_version,
           status, expires_at, generated_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,$10,$11,'ACTIVE',
                   CURRENT_TIMESTAMP + INTERVAL '7 days',CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
         ON CONFLICT (marketplace_customer_id, product_id, recommendation_type, profile_version)
         DO UPDATE SET score=EXCLUDED.score, reason_text=EXCLUDED.reason_text,
                       status='ACTIVE', updated_at=CURRENT_TIMESTAMP`,
        [randomUUID(), tenantId, marketplaceCustomerId, marketplaceAccountId,
          item.product_id, item.variant_id, item.type, item.score, item.reason,
          leadPriority, profileVersion],
      );
    }
  }

  private async getView(
    tenantId: string,
    marketplaceCustomerId: string,
    marketplaceAccountId: string,
  ) {
    const profiles = await AppDataSource.query<ProfileRow[]>(
      `SELECT * FROM customer_ai_profiles
       WHERE tenant_id=$1 AND marketplace_customer_id=$2 LIMIT 1`,
      [tenantId, marketplaceCustomerId],
    );
    const profile = profiles[0];
    const recommendations = await AppDataSource.query(
      `SELECT recommendation.id, recommendation.recommendation_type AS "type",
              recommendation.score::float8 AS score,
              recommendation.reason_text AS reason,
              product.id AS "productId", product.product_name AS "productName",
              variant.id AS "variantId", variant.variant_name AS "variantName",
              variant.price::text AS price, variant.currency,
              (variant.stock_on_hand - variant.reserved_stock) AS "availableStock",
              media.public_url AS "imageUrl"
       FROM customer_ai_product_recommendations recommendation
       JOIN products product ON product.id=recommendation.product_id
        AND product.tenant_id=recommendation.tenant_id
       LEFT JOIN product_variants variant ON variant.id=recommendation.variant_id
        AND variant.tenant_id=recommendation.tenant_id
       LEFT JOIN LATERAL (
         SELECT public_url FROM product_media
         WHERE product_id=product.id AND deleted_at IS NULL
         ORDER BY is_primary DESC, sort_order ASC LIMIT 1
       ) media ON TRUE
       WHERE recommendation.tenant_id=$1
         AND recommendation.marketplace_customer_id=$2
         AND recommendation.marketplace_account_id=$3
         AND recommendation.status='ACTIVE'
         AND (recommendation.expires_at IS NULL OR recommendation.expires_at > CURRENT_TIMESTAMP)
       ORDER BY recommendation.score DESC LIMIT 5`,
      [tenantId, marketplaceCustomerId, marketplaceAccountId],
    );
    if (!profile) {
      return {
        aiProfile: { status: 'EMPTY', version: 0, summary: null, preferences: [] },
        leadPriority: {
          code: 'COLD_LEAD',
          label: priorityLabels.COLD_LEAD,
          definition: priorityDefinitions.COLD_LEAD,
          score: 0.58,
          reason: 'Khách còn mới và chưa thể hiện nhu cầu mua hàng đủ cụ thể.',
          source: 'RULE_ENGINE',
          computedAt: null,
        },
        recommendations: [],
      };
    }
    const features = jsonObject(profile.features_json);
    return {
      aiProfile: {
        status: profile.profile_status,
        version: profile.profile_version,
        summary: profile.profile_summary,
        preferences: preferenceLabels(features),
        features,
        lastComputedAt: profile.last_computed_at,
      },
      leadPriority: profile.lead_priority
        ? {
            code: profile.lead_priority,
            label: priorityLabels[profile.lead_priority],
            definition: priorityDefinitions[profile.lead_priority],
            score: Number(profile.lead_priority_score ?? 0),
            reason: profile.lead_priority_reason,
            source: profile.lead_priority_override ? 'STAFF' : 'RULE_ENGINE',
            computedAt: profile.lead_priority_computed_at,
          }
        : null,
      recommendations,
    };
  }
}

export const customerAiProfileService = new CustomerAiProfileService();
