import { Router } from 'express';
import { receiveMarketplaceMessageWebhook } from '../controller/webhook.controller';

const router = Router();

router.post('/', receiveMarketplaceMessageWebhook);

export default router;
