import axios from 'axios';

export class AiBackendService {
  async processInboundMessage(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
  }) {
    const serviceToken = process.env.AI_SERVICE_TOKEN || '';
    if (!serviceToken) {
      throw new Error('AI_SERVICE_TOKEN is required for autopilot processing.');
    }

    const baseUrl = process.env.AI_BACKEND_URL || 'http://localhost:8083';
    await axios.post(
      new URL('/api/v1/internal/runs', baseUrl).toString(),
      {
        conversation_id: input.conversationId,
        trigger_message_id: input.messageId,
      },
      {
        timeout: 60_000,
        headers: {
          'X-Service-Token': serviceToken,
          'X-Tenant-Id': input.tenantId,
          'Idempotency-Key': `inbound-message:${input.messageId}`,
          'Content-Type': 'application/json',
        },
      },
    );
  }
}
