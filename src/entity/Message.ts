import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Conversation } from './Conversation';

@Entity('messages')
export class Message {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ name: 'conversation_id', type: 'char', length: 36 })
  conversationId!: string;

  @Column({ name: 'external_message_id', type: 'varchar', length: 200, nullable: true })
  externalMessageId!: string | null;

  @Column({ name: 'client_message_id', type: 'varchar', length: 200, nullable: true })
  clientMessageId!: string | null;

  @Column({ name: 'direction', type: 'varchar', length: 10 })
  direction!: 'INBOUND' | 'OUTBOUND';

  @Column({ name: 'sender_type', type: 'varchar', length: 20 })
  senderType!: 'CUSTOMER' | 'STAFF' | 'AI' | 'SYSTEM' | 'SHOP';

  @Column({ name: 'sender_user_id', type: 'char', length: 36, nullable: true })
  senderUserId!: string | null;

  @Column({ name: 'message_type', type: 'varchar', length: 30 })
  messageType!: string;

  @Column({ name: 'text_content', type: 'text', nullable: true })
  textContent!: string | null;

  @Column({ name: 'content_json', type: 'jsonb' })
  contentJson!: Record<string, unknown>;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload!: Record<string, unknown>;

  @Column({ name: 'delivery_status', type: 'varchar', length: 20 })
  deliveryStatus!: string;

  @Column({ name: 'moderation_status', type: 'varchar', length: 20 })
  moderationStatus!: string;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'queued_at', type: 'timestamptz', precision: 3, nullable: true })
  queuedAt!: Date | null;

  @Column({ name: 'sent_at', type: 'timestamptz', precision: 3, nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', precision: 3, nullable: true })
  failedAt!: Date | null;

  @Column({ name: 'external_created_at', type: 'timestamptz', precision: 3, nullable: true })
  externalCreatedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages)
  @JoinColumn({ name: 'conversation_id' })
  conversation!: Conversation;
}
