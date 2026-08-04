import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../config/database';
import type {
  AiStatelessRequest,
  AiStatelessResponse,
} from './aiBackend.service';
import { emitConversationUpdated } from './socket.service';

type ExistingRun = {
  id: string;
  status: string;
};

export class AiAutopilotPersistenceService {
  async beginRun(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    idempotencyKey: string;
  }): Promise<ExistingRun> {
    const existing = await this.findRun(input.tenantId, input.idempotencyKey);
    if (existing) return existing;

    const runId = randomUUID();
    await AppDataSource.query(
      `
        INSERT INTO ai_response_runs (
          id, tenant_id, conversation_id, trigger_message_id,
          idempotency_key, provider, model_name, model_version,
          prompt_version, generated_text, requires_human_review, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $7,
          $8, NULL, TRUE, 'GENERATING'
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      `,
      [
        runId,
        input.tenantId,
        input.conversationId,
        input.messageId,
        input.idempotencyKey,
        (process.env.LLM_PROVIDER || 'stub').toUpperCase(),
        process.env.LLM_MODEL || 'gemini-2.5-flash-lite',
        'stateless-autopilot-v1',
      ],
    );
    return (
      (await this.findRun(input.tenantId, input.idempotencyKey)) || {
        id: runId,
        status: 'GENERATING',
      }
    );
  }

  async saveAiResult(input: {
    tenantId: string;
    runId: string;
    request: AiStatelessRequest;
    response: AiStatelessResponse;
  }) {
    const { response } = input;
    const generatedText = response.reply;
    await AppDataSource.transaction(async (manager) => {
      await manager.query(
        `
          UPDATE ai_response_runs
          SET provider = $1, model_name = $2, model_version = $2,
              generated_text = $3, result_json = $4::jsonb,
              requires_human_review = $5, status = $6,
              confidence = $7, latency_ms = $8,
              input_tokens = $9, output_tokens = $10,
              cached_tokens = $11, estimated_cost_usd = $12,
              token_usage_json = $13::jsonb,
              error_code = NULL, failure_reason = NULL
          WHERE id = $14 AND tenant_id = $15
        `,
        [
          response.provider,
          response.model,
          generatedText,
          JSON.stringify(response),
          response.requires_human,
          response.decision === 'HUMAN_HANDOFF' ? 'HANDED_OFF' : 'GENERATED',
          response.confidence,
          response.latency_ms,
          response.usage.input_tokens ?? null,
          response.usage.output_tokens ?? null,
          response.usage.cached_tokens ?? null,
          response.usage.estimated_cost_usd ?? null,
          JSON.stringify(response.usage),
          input.runId,
          input.tenantId,
        ],
      );

      for (const check of response.quality_checks) {
        await manager.query(
          `
            INSERT INTO ai_quality_checks (
              id, tenant_id, ai_response_run_id, check_type,
              passed, score, findings_json, checker_version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
            ON CONFLICT (ai_response_run_id, check_type) DO UPDATE SET
              passed = EXCLUDED.passed,
              score = EXCLUDED.score,
              findings_json = EXCLUDED.findings_json,
              checker_version = EXCLUDED.checker_version
          `,
          [
            randomUUID(),
            input.tenantId,
            input.runId,
            check.check_type,
            check.passed,
            check.score ?? null,
            JSON.stringify(check.findings || {}),
            check.checker_version,
          ],
        );
      }

      for (const audit of response.tool_audits) {
        await manager.query(
          `
            INSERT INTO ai_tool_calls (
              id, tenant_id, ai_response_run_id, tool_name,
              input_json, output_json, status, error_code, finished_at
            ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8,
                      CURRENT_TIMESTAMP)
          `,
          [
            randomUUID(),
            input.tenantId,
            input.runId,
            audit.tool_name,
            JSON.stringify(audit.input || {}),
            JSON.stringify(audit.output ?? null),
            audit.status,
            audit.error_code ?? null,
          ],
        );
      }

      for (const [index, source] of input.request.sources.entries()) {
        await manager.query(
          `
            INSERT INTO ai_response_sources (
              tenant_id, ai_response_run_id, knowledge_chunk_id,
              rank_number, relevance_score, excerpt_text
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (ai_response_run_id, knowledge_chunk_id) DO NOTHING
          `,
          [
            input.tenantId,
            input.runId,
            source.chunk_id,
            index + 1,
            source.score,
            source.content.slice(0, 2000),
          ],
        );
      }
    });
  }

  async markSent(input: {
    tenantId: string;
    runId: string;
    outputMessageId: string;
  }) {
    await AppDataSource.query(
      `
        UPDATE ai_response_runs
        SET status = 'SENT', output_message_id = $1,
            requires_human_review = FALSE, sent_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND tenant_id = $3
      `,
      [input.outputMessageId, input.runId, input.tenantId],
    );
  }

  async markRejected(input: {
    tenantId: string;
    runId: string;
    reason: string;
  }) {
    await AppDataSource.query(
      `
        UPDATE ai_response_runs
        SET status = 'REJECTED', requires_human_review = TRUE,
            failure_reason = $1
        WHERE id = $2 AND tenant_id = $3 AND status <> 'SENT'
      `,
      [input.reason.slice(0, 4000), input.runId, input.tenantId],
    );
  }

  async markFailed(input: {
    tenantId: string;
    idempotencyKey: string;
    errorCode: string;
    reason: string;
  }) {
    await AppDataSource.query(
      `
        UPDATE ai_response_runs
        SET status = 'FAILED', error_code = $1, failure_reason = $2,
            requires_human_review = TRUE
        WHERE tenant_id = $3 AND idempotency_key = $4
          AND status NOT IN ('SENT', 'HANDED_OFF')
      `,
      [input.errorCode, input.reason.slice(0, 4000), input.tenantId, input.idempotencyKey],
    );
  }

  async handoff(input: {
    tenantId: string;
    conversationId: string;
    runId?: string;
    reasonCode: string;
    reasonText: string;
    priority?: 'NORMAL' | 'HIGH' | 'URGENT';
  }) {
    const priority = input.priority || 'HIGH';
    const handoffId = randomUUID();
    let createdHandoff = false;
    await AppDataSource.transaction(async (manager) => {
      await manager.query(
        `
          UPDATE conversations
          SET ai_mode = 'HUMAN_ONLY', priority = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND tenant_id = $3
        `,
        [priority, input.conversationId, input.tenantId],
      );
      const inserted = await manager.query<Array<{ id: string }>>(
        `
          INSERT INTO human_handoffs (
            id, tenant_id, conversation_id, ai_response_run_id,
            reason_code, reason_text, priority, status
          )
          SELECT $1, $2, $3, $4, $5, $6, $7, 'REQUESTED'
          WHERE NOT EXISTS (
            SELECT 1 FROM human_handoffs
            WHERE tenant_id = $2 AND conversation_id = $3
              AND status IN ('REQUESTED', 'NOTIFIED', 'ACCEPTED')
          )
          RETURNING id
        `,
        [
          handoffId,
          input.tenantId,
          input.conversationId,
          input.runId || null,
          input.reasonCode,
          input.reasonText.slice(0, 4000),
          priority,
        ],
      );
      createdHandoff = inserted.length > 0;
      if (!createdHandoff) return;
      await manager.query(
        `
          INSERT INTO notifications (
            id, tenant_id, recipient_user_id, notification_type,
            channel, title, body_text, reference_type,
            reference_id, status
          ) VALUES ($1, $2, NULL, 'AI_HUMAN_HANDOFF', 'IN_APP',
                    'Hội thoại cần nhân viên xử lý', $3,
                    'CONVERSATION', $4, 'QUEUED')
        `,
        [randomUUID(), input.tenantId, input.reasonText.slice(0, 1000), input.conversationId],
      );
    });

    if (!createdHandoff) return;
    emitConversationUpdated(input.conversationId, {
      conversationId: input.conversationId,
      tenantId: input.tenantId,
      aiMode: 'HUMAN_ONLY',
      priority,
      handoff: {
        id: handoffId,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
      },
    });
  }

  private async findRun(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ExistingRun | null> {
    const rows = await AppDataSource.query<ExistingRun[]>(
      `
        SELECT id, status FROM ai_response_runs
        WHERE tenant_id = $1 AND idempotency_key = $2
        LIMIT 1
      `,
      [tenantId, idempotencyKey],
    );
    return rows[0] || null;
  }
}
