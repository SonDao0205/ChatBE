import { Router } from 'express';
import {
  getConversationDetail,
  getConversationMessages,
  getConversationOrders,
  getConversations,
  markConversationRead,
  sendConversationMessage,
} from '../controller/conversation.controller';
import {
  dismissCustomerRecommendation,
  getCustomerAiProfile,
  refreshCustomerAiProfile,
  updateCustomerLeadPriority,
} from '../controller/customerProfile.controller';

const router = Router();

router.get('/conversations', getConversations);
router.get('/conversations/:conversationId/orders', getConversationOrders);
router.get('/conversations/:conversationId/customer-profile', getCustomerAiProfile);
router.post('/conversations/:conversationId/customer-profile/refresh', refreshCustomerAiProfile);
router.patch(
  '/conversations/:conversationId/customer-profile/lead-priority',
  updateCustomerLeadPriority,
);
router.post(
  '/customer-recommendations/:recommendationId/dismiss',
  dismissCustomerRecommendation,
);
router.get('/conversations/:conversationId', getConversationDetail);
router.patch('/conversations/:conversationId/read', markConversationRead);
router.get('/conversations/:conversationId/messages', getConversationMessages);
router.post('/conversations/:conversationId/messages', sendConversationMessage);

export default router;
