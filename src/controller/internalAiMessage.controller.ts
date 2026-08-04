import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { MarketplaceMessageSenderService } from '../service/marketplaceMessageSender.service';

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

export async function sendApprovedAiMessage(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const expectedToken = process.env.CHAT_BACKEND_SERVICE_TOKEN || '';
    const providedToken = String(request.header('X-Service-Token') || '');
    if (!expectedToken || !tokensMatch(providedToken, expectedToken)) {
      reject(response, 401, 'INVALID_SERVICE_TOKEN', 'Invalid internal service token.');
      return;
    }

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
