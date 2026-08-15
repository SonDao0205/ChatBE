import { Router } from 'express';
import {
  getShopKnowledgeStatus,
  scanPendingAiAutopilotMessage,
  sendApprovedAiMessage,
  receiveOrderStatusUpdated,
} from '../controller/internalAiMessage.controller';

const router = Router();

router.post('/internal/ai/messages', sendApprovedAiMessage);
router.post('/internal/ai/autopilot/scan', scanPendingAiAutopilotMessage);
router.get('/internal/ai/shop-knowledge/status', getShopKnowledgeStatus);
router.post('/internal/orders/status-updated', receiveOrderStatusUpdated);

export default router;
