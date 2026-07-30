import { Router } from 'express';
import {
  getConversationDetail,
  getConversationMessages,
  getConversationOrders,
  getConversations,
  markConversationRead,
  sendConversationMessage,
} from '../controller/conversation.controller';

const router = Router();

router.get('/conversations', getConversations);
router.get('/conversations/:conversationId/orders', getConversationOrders);
router.get('/conversations/:conversationId', getConversationDetail);
router.patch('/conversations/:conversationId/read', markConversationRead);
router.get('/conversations/:conversationId/messages', getConversationMessages);
router.post('/conversations/:conversationId/messages', sendConversationMessage);

export default router;
