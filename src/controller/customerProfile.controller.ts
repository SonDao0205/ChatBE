import type { NextFunction, Request, Response } from 'express';
import {
  customerAiProfileService,
  type LeadPriority,
} from '../service/customerAiProfile.service';

const defaultTenantId =
  process.env.DEFAULT_TENANT_ID || '20000000-0000-0000-0000-000000000001';
const leadPriorities = new Set<LeadPriority>([
  'HOT_LEAD',
  'WARM_LEAD',
  'COLD_LEAD',
  'EXISTING_PRIORITY',
]);

function tenantId(request: Request) {
  return String(request.body?.tenantId || request.query.tenantId || defaultTenantId);
}

export async function getCustomerAiProfile(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const result = await customerAiProfileService.getByConversation(
      tenantId(request),
      String(request.params.conversationId),
    );
    if (!result) {
      response.status(404).json({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
        data: null,
      });
      return;
    }
    response.json({ code: 0, message: 'Success', data: result });
  } catch (error) {
    next(error);
  }
}

export async function refreshCustomerAiProfile(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const result = await customerAiProfileService.refreshByConversation(
      tenantId(request),
      String(request.params.conversationId),
    );
    if (!result) {
      response.status(404).json({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
        data: null,
      });
      return;
    }
    response.json({ code: 0, message: 'Customer profile refreshed', data: result });
  } catch (error) {
    next(error);
  }
}

export async function updateCustomerLeadPriority(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const priority = String(request.body?.priority || '') as LeadPriority;
    const reason = String(request.body?.reason || '').trim();
    if (!leadPriorities.has(priority) || reason.length < 3 || reason.length > 500) {
      response.status(422).json({
        code: 'INVALID_LEAD_PRIORITY',
        message: 'Priority or reason is invalid.',
        data: null,
      });
      return;
    }
    const result = await customerAiProfileService.overrideLeadPriority(
      tenantId(request),
      String(request.params.conversationId),
      priority,
      reason,
    );
    if (!result) {
      response.status(404).json({
        code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found.', data: null,
      });
      return;
    }
    response.json({ code: 0, message: 'Lead priority updated', data: result });
  } catch (error) {
    next(error);
  }
}

export async function dismissCustomerRecommendation(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const dismissed = await customerAiProfileService.dismissRecommendation(
      tenantId(request),
      String(request.params.recommendationId),
    );
    if (!dismissed) {
      response.status(404).json({
        code: 'RECOMMENDATION_NOT_FOUND',
        message: 'Recommendation not found.',
        data: null,
      });
      return;
    }
    response.json({ code: 0, message: 'Recommendation dismissed', data: null });
  } catch (error) {
    next(error);
  }
}
