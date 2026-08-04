import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { enqueueAiAutopilot } from '../service/aiAutopilotQueue.service';
import { MarketplaceMessageSenderService } from '../service/marketplaceMessageSender.service';
import { shopKnowledgeService } from '../service/shopKnowledge.service';

const marketplaceMessageSenderService = new MarketplaceMessageSenderService();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokensMatch(provided: string, expected: string) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function reject(response: Response, status: number, code: string, message: string) {
  response.status(status).json({ code, message, data: null });
}

function requireInternalService(request: Request, response: Response) {
  const expectedToken = process.env.CHAT_BACKEND_SERVICE_TOKEN || '';
  const providedToken = String(request.header('X-Service-Token') || '');
  if (!expectedToken || !tokensMatch(providedToken, expectedToken)) {
    reject(response, 401, 'INVALID_SERVICE_TOKEN', 'Invalid internal service token.');
    return false;
  }
  return true;
}

export async function sendApprovedAiMessage(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    if (!requireInternalService(request, response)) return;

    const tenantId = String(request.header('X-Tenant-Id') || '');
    const idempotencyKey = String(request.header('Idempotency-Key') || '');
    const conversationId = String(request.body.conversationId || '');
    const aiResponseRunId = String(request.body.aiResponseRunId || '');
    const text = String(request.body.text || '').trim();

    if (!uuidPattern.test(tenantId)) {
      reject(response, 422, 'INVALID_TENANT_ID', 'X-Tenant-Id must be a UUID.');
      return;
    }
    if (!uuidPattern.test(conversationId) || !uuidPattern.test(aiResponseRunId)) {
      reject(response, 422, 'INVALID_AI_MESSAGE', 'Conversation and AI run IDs must be UUIDs.');
      return;
    }
    if (!idempotencyKey || idempotencyKey.length > 200) {
      reject(response, 422, 'INVALID_IDEMPOTENCY_KEY', 'A valid Idempotency-Key is required.');
      return;
    }
    if (!text || text.length > 8000 || request.body.senderType !== 'AI') {
      reject(response, 422, 'INVALID_AI_MESSAGE', 'A valid AI text message is required.');
      return;
    }

    const message = await marketplaceMessageSenderService.sendSellerMessage({
      tenantId,
      conversationId,
      text,
      senderType: 'AI',
      aiResponseRunId,
      idempotencyKey,
    });

    if (!['SENT', 'DELIVERED', 'READ'].includes(message.deliveryStatus)) {
      reject(
        response,
        409,
        'AI_MESSAGE_IN_PROGRESS',
        'The same AI message is already being delivered.',
      );
      return;
    }

    response.status(201).json({
      code: 0,
      message: 'AI message sent',
      data: message,
    });
  } catch (error) {
    next(error);
  }
}

export async function scanPendingAiAutopilotMessage(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    if (!requireInternalService(request, response)) return;

    const tenantId = String(request.header('X-Tenant-Id') || '');
    const conversationId = String(request.body.conversationId || '');
    if (!uuidPattern.test(tenantId) || !uuidPattern.test(conversationId)) {
      reject(
        response,
        422,
        'INVALID_AUTOPILOT_SCAN',
        'Tenant and conversation IDs must be UUIDs.',
      );
      return;
    }

    const rows = await AppDataSource.query<
      Array<{
        ai_mode: string;
        message_id: string | null;
      }>
    >(
      `
        SELECT conversation.ai_mode,
               CASE
                 WHEN trigger_message.direction = 'INBOUND'
                  AND trigger_message.sender_type = 'CUSTOMER'
                  AND NULLIF(BTRIM(trigger_message.text_content), '') IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM messages reply
                    WHERE reply.tenant_id = conversation.tenant_id
                      AND reply.conversation_id = conversation.id
                      AND reply.direction = 'OUTBOUND'
                      AND COALESCE(reply.external_created_at, reply.created_at)
                          > COALESCE(
                              trigger_message.external_created_at,
                              trigger_message.created_at
                            )
                  )
                 THEN trigger_message.id
                 ELSE NULL
               END AS message_id
        FROM conversations conversation
        LEFT JOIN messages trigger_message
          ON trigger_message.id = conversation.last_message_id
         AND trigger_message.tenant_id = conversation.tenant_id
         AND trigger_message.conversation_id = conversation.id
        WHERE conversation.id = $1
          AND conversation.tenant_id = $2
        LIMIT 1
      `,
      [conversationId, tenantId],
    );
    const pending = rows[0];
    if (!pending) {
      reject(response, 404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      return;
    }
    if (pending.ai_mode !== 'AUTO') {
      reject(response, 409, 'AUTOPILOT_NOT_ACTIVE', 'Conversation is not in AUTO mode.');
      return;
    }
    if (!pending.message_id) {
      response.json({
        code: 0,
        message: 'No pending customer message',
        data: { status: 'NO_PENDING_MESSAGE', messageId: null },
      });
      return;
    }

    await enqueueAiAutopilot({
      tenantId,
      conversationId,
      messageId: pending.message_id,
    });
    response.status(202).json({
      code: 0,
      message: 'Pending customer message queued for AI Autopilot',
      data: { status: 'QUEUED', messageId: pending.message_id },
    });
  } catch (error) {
    next(error);
  }
}

export async function getShopKnowledgeStatus(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    if (!requireInternalService(request, response)) return;
    const tenantId = String(request.header('X-Tenant-Id') || '');
    const marketplaceAccountId = String(request.query.marketplaceAccountId || '');
    if (!uuidPattern.test(tenantId) || !uuidPattern.test(marketplaceAccountId)) {
      reject(response, 422, 'INVALID_SHOP_KNOWLEDGE_REQUEST', 'Tenant and shop IDs must be UUIDs.');
      return;
    }
    response.json({
      code: 0,
      message: 'OK',
      data: await shopKnowledgeService.status(tenantId, marketplaceAccountId),
    });
  } catch (error) {
    next(error);
  }
}
