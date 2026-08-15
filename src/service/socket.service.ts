import type { Server } from 'socket.io';

let socketServer: Server | null = null;

export function setSocketServer(server: Server) {
  socketServer = server;
}

export function emitConversationUpdated(conversationId: string, payload: unknown) {
  socketServer?.emit('conversation_updated', payload);
  socketServer
    ?.to(`conversation:${conversationId}`)
    .emit('conversation_updated', payload);
}

export function emitMessageCreated(conversationId: string, payload: unknown) {
  socketServer?.emit('message_created', payload);
  socketServer?.to(`conversation:${conversationId}`).emit('message_created', payload);
}

export function emitCustomerProfileUpdated(
  marketplaceCustomerId: string,
  payload: unknown,
) {
  socketServer?.emit('customer_profile_updated', payload);
  socketServer
    ?.to(`customer:${marketplaceCustomerId}`)
    .emit('customer_profile_updated', payload);
}

export function emitOrderUpdated(payload: unknown) {
  socketServer?.emit('order_updated', payload);
}
