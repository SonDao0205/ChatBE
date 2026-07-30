import { AppDataSource } from '../config/database';
import { Conversation } from '../entity/Conversation';
import { onlyLinkedMarketplaceAccount } from './marketplaceAccount.repository';

export class ConversationRepository {
  private readonly repository = AppDataSource.getRepository(Conversation);

  findConnectedConversations(input: {
    tenantId: string;
    marketplaceCode: string | null;
  }) {
    const query = this.repository
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.marketplaceCustomer', 'customer')
      .innerJoinAndSelect('conversation.marketplaceAccount', 'account')
      .innerJoinAndSelect('account.marketplace', 'marketplace')
      .where('conversation.tenant_id = :tenantId', {
        tenantId: input.tenantId,
      })
      .orderBy('conversation.last_message_at', 'DESC');

    onlyLinkedMarketplaceAccount(query);

    if (input.marketplaceCode) {
      query.andWhere('marketplace.marketplace_code = :marketplaceCode', {
        marketplaceCode: input.marketplaceCode,
      });
    }

    return query.getMany();
  }

  findConnectedDetail(input: { tenantId: string; conversationId: string }) {
    const query = this.repository
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.marketplaceCustomer', 'customer')
      .innerJoinAndSelect('conversation.marketplaceAccount', 'account')
      .innerJoinAndSelect('account.marketplace', 'marketplace')
      .where('conversation.id = :conversationId', {
        conversationId: input.conversationId,
      })
      .andWhere('conversation.tenant_id = :tenantId', {
        tenantId: input.tenantId,
      });

    return onlyLinkedMarketplaceAccount(query).getOne();
  }

  findConnectedForOrders(input: { tenantId: string; conversationId: string }) {
    const query = this.repository
      .createQueryBuilder('conversation')
      .innerJoin('conversation.marketplaceAccount', 'account')
      .where('conversation.id = :conversationId', {
        conversationId: input.conversationId,
      })
      .andWhere('conversation.tenant_id = :tenantId', {
        tenantId: input.tenantId,
      });

    return onlyLinkedMarketplaceAccount(query).getOne();
  }

  findConnectedForSellerMessage(input: {
    tenantId: string;
    conversationId: string;
  }) {
    return this.repository
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.marketplaceAccount', 'account')
      .innerJoinAndSelect('account.marketplace', 'marketplace')
      .where('conversation.id = :conversationId', {
        conversationId: input.conversationId,
      })
      .andWhere('conversation.tenant_id = :tenantId', {
        tenantId: input.tenantId,
      })
      .andWhere('account.connection_status = :connectionStatus', {
        connectionStatus: 'CONNECTED',
      })
      .andWhere('account.deleted_at IS NULL')
      .andWhere('(account.expires_at IS NULL OR account.expires_at > UTC_TIMESTAMP(3))')
      .getOne();
  }

  findByTenantAccountAndExternalConversation(input: {
    tenantId: string;
    marketplaceAccountId: string;
    externalConversationId: string;
  }) {
    return this.repository.findOne({
      where: {
        tenantId: input.tenantId,
        marketplaceAccountId: input.marketplaceAccountId,
        externalConversationId: input.externalConversationId,
      },
      relations: {
        marketplaceCustomer: true,
      },
    });
  }

  save(conversation: Conversation | Partial<Conversation>) {
    return this.repository.save(conversation);
  }
}
