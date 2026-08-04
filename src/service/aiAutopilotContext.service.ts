import { AppDataSource } from '../config/database';
import type { AiStatelessRequest, AiStatelessSource } from './aiBackend.service';
import { hybridProductRetriever } from './hybridProductRetriever.service';
import { customerOrderFactsService } from './customerOrderFacts.service';
import { compactAiFacts } from './aiFactsCompactor';

type ConversationRow = {
  id: string;
  tenant_id: string;
  marketplace_account_id: string;
  marketplace_customer_id: string;
  ai_mode: string;
  last_message_id: string | null;
  external_shop_name: string;
  context_name: string | null;
  mood: string | null;
  assistant_name: string | null;
  business_description: string | null;
  brand_voice: string | null;
  response_guidelines: string | null;
  prohibited_topics_json: unknown;
  default_language: string | null;
  max_response_characters: number | null;
  default_knowledge_base_id: string | null;
};

type MessageRow = {
  id: string;
  sender_type: 'CUSTOMER' | 'STAFF' | 'AI' | 'SYSTEM' | 'SHOP';
  direction: 'INBOUND' | 'OUTBOUND';
  text_content: string | null;
  created_at: Date;
};

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export type LoadedAiAutopilotContext = {
  payload: AiStatelessRequest;
  aiMode: string;
  lastMessageId: string | null;
  triggerCreatedAt: Date;
  tokenLimit: number;
  tokensUsed: number;
  humanRespondedAfterTrigger: boolean;
};

export class AiAutopilotContextService {
  async getSendGuard(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    triggerCreatedAt: Date;
  }) {
    const rows = await AppDataSource.query<
      Array<{
        ai_mode: string;
        last_message_id: string | null;
        human_responded: boolean;
      }>
    >(
      `
        SELECT c.ai_mode, c.last_message_id,
               EXISTS (
                 SELECT 1 FROM messages message
                 WHERE message.conversation_id = c.id
                   AND message.tenant_id = c.tenant_id
                   AND message.direction = 'OUTBOUND'
                   AND message.sender_type = 'STAFF'
                   AND message.created_at > $3
               ) AS human_responded
        FROM conversations c
        WHERE c.id = $1 AND c.tenant_id = $2
        LIMIT 1
      `,
      [
        input.conversationId,
        input.tenantId,
        input.triggerCreatedAt,
      ],
    );
    const current = rows[0];
    if (!current) return 'SUPERSEDED' as const;
    if (current.ai_mode !== 'AUTO') return 'DISABLED' as const;
    if (current.human_responded) return 'HUMAN_RESPONDED' as const;
    if (current.last_message_id !== input.messageId) return 'SUPERSEDED' as const;
    return 'READY' as const;
  }

  async load(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    requestId: string;
  }): Promise<LoadedAiAutopilotContext | null> {
    const conversations = await AppDataSource.query<ConversationRow[]>(
      `
        SELECT c.id, c.tenant_id, c.marketplace_account_id,
               c.marketplace_customer_id, c.ai_mode, c.last_message_id,
               ma.external_shop_name,
               context.context_name, context.mood, context.assistant_name,
               context.business_description, context.brand_voice,
               context.response_guidelines, context.prohibited_topics_json,
               context.default_language, context.max_response_characters,
               context.default_knowledge_base_id
        FROM conversations c
        JOIN marketplace_accounts ma
          ON ma.id = c.marketplace_account_id
         AND ma.tenant_id = c.tenant_id
         AND ma.deleted_at IS NULL
        LEFT JOIN ai_shop_contexts context
          ON context.marketplace_account_id = c.marketplace_account_id
         AND context.tenant_id = c.tenant_id
         AND context.is_active = TRUE
         AND context.deleted_at IS NULL
        WHERE c.id = $1 AND c.tenant_id = $2
        LIMIT 1
      `,
      [input.conversationId, input.tenantId],
    );
    const conversation = conversations[0];
    if (!conversation) return null;

    const triggerRows = await AppDataSource.query<MessageRow[]>(
      `
        SELECT id, sender_type, direction, text_content, created_at
        FROM messages
        WHERE id = $1 AND conversation_id = $2 AND tenant_id = $3
        LIMIT 1
      `,
      [input.messageId, input.conversationId, input.tenantId],
    );
    const trigger = triggerRows[0];
    if (
      !trigger?.text_content?.trim() ||
      trigger.direction !== 'INBOUND' ||
      trigger.sender_type !== 'CUSTOMER'
    ) {
      return null;
    }

    const recentRows = await AppDataSource.query<MessageRow[]>(
      `
        SELECT id, sender_type, direction, text_content, created_at
        FROM (
          SELECT id, sender_type, direction, text_content, created_at
          FROM messages
          WHERE conversation_id = $1
            AND tenant_id = $2
            AND text_content IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 10
        ) recent
        ORDER BY created_at ASC
      `,
      [input.conversationId, input.tenantId],
    );
    const humanRespondedRows = await AppDataSource.query<Array<{ exists: boolean }>>(
      `
        SELECT EXISTS (
          SELECT 1 FROM messages
          WHERE conversation_id = $1 AND tenant_id = $2
            AND direction = 'OUTBOUND' AND sender_type = 'STAFF'
            AND created_at > $3
        ) AS exists
      `,
      [input.conversationId, input.tenantId, trigger.created_at],
    );

    const facts = await this.loadFacts(
      input.tenantId,
      conversation.marketplace_account_id,
      conversation.marketplace_customer_id,
      trigger.text_content,
    );
    const sources = await this.loadSources(
      input.tenantId,
      conversation.default_knowledge_base_id,
      trigger.text_content,
    );
    const previousRows = await AppDataSource.query<Array<{ generated_text: string }>>(
      `
        SELECT generated_text
        FROM ai_response_runs
        WHERE tenant_id = $1 AND conversation_id = $2
          AND generated_text IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.tenantId, input.conversationId],
    );
    const quota = await this.loadTokenQuota(input.tenantId);

    return {
      payload: {
        request_id: input.requestId,
        conversation_id: input.conversationId,
        trigger_message_id: input.messageId,
        marketplace_account_id: conversation.marketplace_account_id,
        customer_id: conversation.marketplace_customer_id,
        message: trigger.text_content,
        recent_messages: recentRows
          .filter((item) => item.text_content?.trim())
          .slice(-8)
          .map((item) => ({
            sender_type: item.sender_type,
            text_content: item.text_content!.trim().slice(0, 1000),
          })),
        shop_context: {
          context_name: conversation.context_name || 'Mặc định an toàn',
          mood: conversation.mood || 'FRIENDLY',
          assistant_name: conversation.assistant_name || 'Trợ lý cửa hàng',
          business_name: conversation.external_shop_name,
          business_description: conversation.business_description || '',
          brand_voice: conversation.brand_voice || 'Thân thiện, lịch sự',
          response_guidelines: conversation.response_guidelines || '',
          prohibited_topics: listValue(conversation.prohibited_topics_json),
          default_language: conversation.default_language || 'vi',
          max_response_characters:
            conversation.max_response_characters || 1200,
        },
        facts: compactAiFacts(facts),
        sources: sources.slice(0, 5).map((source) => ({
          ...source,
          content: source.content.slice(0, 1200),
        })),
        previous_ai_text: previousRows[0]?.generated_text || null,
      },
      aiMode: conversation.ai_mode,
      lastMessageId: conversation.last_message_id,
      triggerCreatedAt: trigger.created_at,
      tokenLimit: quota.limit,
      tokensUsed: quota.used,
      humanRespondedAfterTrigger: Boolean(humanRespondedRows[0]?.exists),
    };
  }

  private async loadFacts(
    tenantId: string,
    marketplaceAccountId: string,
    customerId: string,
    message: string,
  ): Promise<Record<string, unknown>> {
    const facts = await customerOrderFactsService.load({
      tenantId,
      marketplaceAccountId,
      customerId,
      message,
    });

    const product = await hybridProductRetriever.retrieve(
      tenantId,
      marketplaceAccountId,
      message,
    );
    if (product) facts.product = product;

    return facts;
  }

  private async loadSources(
    tenantId: string,
    knowledgeBaseId: string | null,
    message: string,
  ): Promise<AiStatelessSource[]> {
    if (!knowledgeBaseId) return [];
    const terms = [...new Set(message.toLowerCase().split(/\s+/))]
      .filter((word) => word.length >= 4)
      .slice(0, 5)
      .map((word) => `%${word.replaceAll('%', '').replaceAll('_', '')}%`);
    if (terms.length === 0) return [];
    const rows = await AppDataSource.query<
      Array<{
        id: string;
        document_id: string;
        title: string;
        content_text: string;
      }>
    >(
      `
        SELECT chunk.id, document.id AS document_id, document.title,
               chunk.content_text
        FROM knowledge_chunks chunk
        JOIN knowledge_documents document
          ON document.id = chunk.knowledge_document_id
         AND document.tenant_id = chunk.tenant_id
        WHERE chunk.tenant_id = $1
          AND document.knowledge_base_id = $2
          AND document.status = 'INDEXED'
          AND document.deleted_at IS NULL
          AND chunk.content_text ILIKE ANY($3::text[])
        ORDER BY document.updated_at DESC, chunk.chunk_index ASC
        LIMIT 5
      `,
      [tenantId, knowledgeBaseId, terms],
    );
    return rows.map((row) => ({
      chunk_id: row.id,
      document_id: row.document_id,
      title: row.title,
      content: row.content_text,
      score: 0.7,
    }));
  }

  private async loadTokenQuota(tenantId: string) {
    const defaultLimit = Number(process.env.AI_MONTHLY_TOKEN_LIMIT || 2_000_000);
    const rows = await AppDataSource.query<Array<{ used: string; token_limit: string | null }>>(
      `
        SELECT COALESCE(SUM(COALESCE(run.input_tokens, 0) +
                            COALESCE(run.output_tokens, 0)), 0)::text AS used,
               (
                 SELECT plan.limits_json ->> 'ai_monthly_tokens'
                 FROM tenant_subscriptions subscription
                 JOIN subscription_plans plan
                   ON plan.id = subscription.subscription_plan_id
                 WHERE subscription.tenant_id = $1
                   AND subscription.status IN ('TRIAL', 'ACTIVE')
                 ORDER BY subscription.created_at DESC
                 LIMIT 1
               ) AS token_limit
        FROM ai_response_runs run
        WHERE run.tenant_id = $1
          AND run.created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
      `,
      [tenantId],
    );
    const configured = Number(rows[0]?.token_limit || defaultLimit);
    return {
      used: Number(rows[0]?.used || 0),
      limit: Number.isFinite(configured) && configured > 0 ? configured : defaultLimit,
    };
  }
}
