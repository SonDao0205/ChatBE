import type { NextFunction, Request, Response } from 'express';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Conversation } from '../entity/Conversation';
import { Message } from '../entity/Message';
import { MarketplaceMessageSenderService } from '../service/marketplaceMessageSender.service';
import { emitConversationUpdated } from '../service/socket.service';

const defaultTenantId =
  process.env.DEFAULT_TENANT_ID || '20000000-0000-0000-0000-000000000001';
const marketplaceMessageSenderService = new MarketplaceMessageSenderService();

function marketplaceFilter(channel: string) {
  const normalized = channel.toUpperCase();
  if (normalized === 'TIKTOK_SHOP' || normalized === 'LAZADA') {
    return normalized;
  }
  return null;
}

function onlyConnectedMarketplaceAccount<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  accountAlias = 'account',
  credentialsAlias = 'credentials',
) {
  return query
    .innerJoin(`${accountAlias}.credentials`, credentialsAlias)
    .andWhere(`${accountAlias}.connection_status = :connectedStatus`, {
      connectedStatus: 'CONNECTED',
    })
    .andWhere(`${accountAlias}.deleted_at IS NULL`)
    .andWhere(
      `(${accountAlias}.expires_at IS NULL OR ${accountAlias}.expires_at > CURRENT_TIMESTAMP)`,
    )
    .andWhere(
      `(${credentialsAlias}.access_token_expires_at IS NULL OR ${credentialsAlias}.access_token_expires_at > CURRENT_TIMESTAMP)`,
    );
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

    const query = AppDataSource.getRepository(Conversation)
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.marketplaceCustomer', 'customer')
      .innerJoinAndSelect('conversation.marketplaceAccount', 'account')
      .innerJoinAndSelect('account.marketplace', 'marketplace')
      .where('conversation.tenant_id = :tenantId', { tenantId })
      .orderBy('conversation.last_message_at', 'DESC');

    onlyConnectedMarketplaceAccount(query);

    if (selectedMarketplaceCode) {
      query.andWhere('marketplace.marketplace_code = :marketplaceCode', {
        marketplaceCode: selectedMarketplaceCode,
      });
    }

    const conversations = await query.getMany();

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
    const query = AppDataSource.getRepository(Conversation)
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.marketplaceCustomer', 'customer')
      .innerJoinAndSelect('conversation.marketplaceAccount', 'account')
      .innerJoinAndSelect('account.marketplace', 'marketplace')
      .where('conversation.id = :conversationId', { conversationId })
      .andWhere('conversation.tenant_id = :tenantId', { tenantId });

    onlyConnectedMarketplaceAccount(query);

    const conversation = await query.getOne();

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
    const query = AppDataSource.getRepository(Message)
      .createQueryBuilder('message')
      .innerJoin('message.conversation', 'conversation')
      .innerJoin('conversation.marketplaceAccount', 'account')
      .where('message.conversation_id = :conversationId', {
        conversationId,
      })
      .andWhere('message.tenant_id = :tenantId', { tenantId })
      .andWhere('conversation.tenant_id = :tenantId', { tenantId })
      .orderBy('COALESCE(message.external_created_at, message.created_at)', 'ASC');

    onlyConnectedMarketplaceAccount(query);

    const messages = await query.getMany();

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
    const query = AppDataSource.getRepository(Conversation)
      .createQueryBuilder('conversation')
      .innerJoin('conversation.marketplaceAccount', 'account')
      .where('conversation.id = :conversationId', { conversationId })
      .andWhere('conversation.tenant_id = :tenantId', { tenantId });

    onlyConnectedMarketplaceAccount(query);

    const conversation = await query.getOne();

    if (!conversation) {
      response.status(404).json({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
        data: null,
      });
      return;
    }

    const orders = await AppDataSource.query(
      `
      SELECT
        order_record.id,
        order_record.external_order_id AS externalOrderId,
        order_record.canonical_status AS canonicalStatus,
        order_record.payment_status AS paymentStatus,
        order_record.refund_status AS refundStatus,
        order_record.currency,
        CAST(order_record.total_amount AS TEXT) AS totalAmount,
        order_record.external_created_at AS externalCreatedAt,
        marketplace.marketplace_name AS channelName,
        COALESCE(
          STRING_AGG(
            CONCAT(
              order_item.product_name_snapshot,
              CASE
                WHEN order_item.quantity > 1 THEN CONCAT(' x', order_item.quantity)
                ELSE ''
              END
            ),
            ', ' ORDER BY order_item.created_at ASC
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
      WHERE order_record.tenant_id = $1
        AND order_record.marketplace_account_id = $2
        AND order_record.marketplace_customer_id = $3
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
        tenantId,
        conversation.marketplaceAccountId,
        conversation.marketplaceCustomerId,
      ],
    );

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
    const conversationRepository = AppDataSource.getRepository(Conversation);
    const query = conversationRepository
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.marketplaceCustomer', 'customer')
      .innerJoinAndSelect('conversation.marketplaceAccount', 'account')
      .innerJoinAndSelect('account.marketplace', 'marketplace')
      .where('conversation.id = :conversationId', { conversationId })
      .andWhere('conversation.tenant_id = :tenantId', { tenantId });

    onlyConnectedMarketplaceAccount(query);

    const conversation = await query.getOne();

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
