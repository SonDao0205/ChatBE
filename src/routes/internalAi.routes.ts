import { Router } from 'express';
import { sendApprovedAiMessage } from '../controller/internalAiMessage.controller';

const router = Router();

router.post('/internal/ai/messages', sendApprovedAiMessage);

export default router;
