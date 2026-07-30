import type { NextFunction, Request, Response } from 'express';
import { ConversationRepository } from '../repository/conversation.repository';
import { MessageRepository } from '../repository/message.repository';
import { OrderRepository } from '../repository/order.repository';
import { MarketplaceMessageSenderService } from '../service/marketplaceMessageSender.service';
import { emitConversationUpdated } from '../service/socket.service';

const defaultTenantId =
  process.env.DEFAULT_TENANT_ID || '20000000-0000-0000-0000-000000000001';
const conversationRepository = new ConversationRepository();
const messageRepository = new MessageRepository();
const orderRepository = new OrderRepository();
const marketplaceMessageSenderService = new MarketplaceMessageSenderService();

function marketplaceFilter(channel: string) {
  const normalized = channel.toUpperCase();
  if (normalized === 'TIKTOK_SHOP' || normalized === 'LAZADA') {
    return normalized;
  }
  return null;
}

export async function getConversations(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const tenantId = String(request.query.tenantId || defaultTenantId);
    const channel = String(request.query.channel || 'all');
    const selectedMarketplaceCode = marketplaceFilter(channel);

    const conversations = await conversationRepository.findConnectedConversations({
      tenantId,
      marketplaceCode: selectedMarketplaceCode,
    });

    response.json({
      code: 0,
      message: 'Success',
      data: conversations.map((conversation) => ({
        id: conversation.id,
        channel: conversation.marketplaceAccount.marketplace.marketplaceCode,
        channelName: conversation.marketplaceAccount.marketplace.marketplaceName,
        customerName:
          conversation.marketplaceCustomer.displayName ||
          conversation.marketplaceCustomer.externalCustomerId,
        avatarUrl: conversation.marketplaceCustomer.avatarUrl,
        phone: conversation.marketplaceCustomer.phoneMasked,
        status: conversation.internalStatus,
        priority: conversation.priority,
        unreadCount: conversation.unreadCount,
        lastMessage: conversation.lastMessagePreview,
        lastMessageAt: conversation.lastMessageAt,
      })),
    });
  } catch (error) {
    next(error);
  }
}

export async function getConversationDetail(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const tenantId = String(request.query.tenantId || defaultTenantId);
    const conversationId = String(request.params.conversationId);
    const conversation = await conversationRepository.findConnectedDetail({
      tenantId,
      conversationId,
    });

    if (!conversation) {
      response.status(404).json({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
        data: null,
      });
      return;
    }

    response.json({
      code: 0,
      message: 'Success',
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

export async function getConversationMessages(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const tenantId = String(request.query.tenantId || defaultTenantId);
    const conversationId = String(request.params.conversationId);
    const messages = await messageRepository.findConnectedConversationMessages({
      tenantId,
      conversationId,
    });

    response.json({
      code: 0,
      message: 'Success',
      data: messages,
    });
  } catch (error) {
    next(error);
  }
}

export async function getConversationOrders(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const tenantId = String(request.query.tenantId || defaultTenantId);
    const conversationId = String(request.params.conversationId);
    const conversation = await conversationRepository.findConnectedForOrders({
      tenantId,
      conversationId,
    });

    if (!conversation) {
      response.status(404).json({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
        data: null,
      });
      return;
    }

    const orders = await orderRepository.findConversationOrders({
      tenantId,
      marketplaceAccountId: conversation.marketplaceAccountId,
      marketplaceCustomerId: conversation.marketplaceCustomerId,
    });

    response.json({
      code: 0,
      message: 'Success',
      data: {
        totalOrders: orders.length,
        latestOrderTotal: orders[0]?.totalAmount ?? '0',
        orders,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function markConversationRead(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const tenantId = String(request.body.tenantId || request.query.tenantId || defaultTenantId);
    const conversationId = String(request.params.conversationId);
    const conversation = await conversationRepository.findConnectedDetail({
      tenantId,
      conversationId,
    });

    if (!conversation) {
      response.status(404).json({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
        data: null,
      });
      return;
    }

    if (conversation.unreadCount > 0) {
      conversation.unreadCount = 0;
      await conversationRepository.save(conversation);

      emitConversationUpdated(conversation.id, {
        conversationId: conversation.id,
        conversation,
      });
    }

    response.json({
      code: 0,
      message: 'Conversation marked as read',
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

export async function sendConversationMessage(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const tenantId = String(request.body.tenantId || defaultTenantId);
    const text = String(request.body.text || '');

    const message = await marketplaceMessageSenderService.sendSellerMessage({
      tenantId,
      conversationId: String(request.params.conversationId),
      text,
      senderUserId: request.body.senderUserId,
    });

    response.status(201).json({
      code: 0,
      message: 'Message sent',
      data: message,
    });
  } catch (error) {
    next(error);
  }
}
