import { AppDataSource } from '../config/database';
import { Message } from '../entity/Message';
import { onlyLinkedMarketplaceAccount } from './marketplaceAccount.repository';

export class MessageRepository {
  private readonly repository = AppDataSource.getRepository(Message);

  findConnectedConversationMessages(input: {
    tenantId: string;
    conversationId: string;
  }) {
    const query = this.repository
      .createQueryBuilder('message')
      .innerJoin('message.conversation', 'conversation')
      .innerJoin('conversation.marketplaceAccount', 'account')
      .where('message.conversation_id = :conversationId', {
        conversationId: input.conversationId,
      })
      .andWhere('message.tenant_id = :tenantId', {
        tenantId: input.tenantId,
      })
      .andWhere('conversation.tenant_id = :tenantId', {
        tenantId: input.tenantId,
      })
      .orderBy('COALESCE(message.external_created_at, message.created_at)', 'ASC');

    return onlyLinkedMarketplaceAccount(query).getMany();
  }

  findByConversationAndExternalMessage(input: {
    conversationId: string;
    externalMessageId: string;
  }) {
    return this.repository.findOneBy({
      conversationId: input.conversationId,
      externalMessageId: input.externalMessageId,
    });
  }

  create(input: Partial<Message>) {
    return this.repository.create(input);
  }

  save(message: Message | Partial<Message>) {
    return this.repository.save(message);
  }
}
