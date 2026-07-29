import type { NextFunction, Request, Response } from 'express';
import {
  MarketplaceWebhookService,
  WebhookAuthenticationError,
} from '../service/marketplaceWebhook.service';

const marketplaceWebhookService = new MarketplaceWebhookService();

export async function receiveMarketplaceMessageWebhook(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(JSON.stringify(request.body ?? {}));

    await marketplaceWebhookService.receive({
      rawBody,
      headers: request.headers,
    });

    response.status(200).json({
      code: 0,
      message: 'Webhook received',
      data: null,
    });
  } catch (error) {
    if (error instanceof WebhookAuthenticationError) {
      response.status(401).json({
        code: 'WEBHOOK_AUTHENTICATION_FAILED',
        message: error.message,
        data: null,
      });
      return;
    }

    next(error);
  }
}
