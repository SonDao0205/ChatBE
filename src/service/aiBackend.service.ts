import axios from 'axios';

export type AiStatelessSource = {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  score: number;
};

export type AiStatelessRequest = {
  request_id: string;
  conversation_id: string;
  trigger_message_id: string;
  marketplace_account_id: string;
  customer_id: string;
  message: string;
  recent_messages: Array<{
    sender_type: 'CUSTOMER' | 'STAFF' | 'AI' | 'SYSTEM' | 'SHOP';
    text_content: string;
  }>;
  shop_context: Record<string, unknown>;
  facts: Record<string, unknown>;
  sources: AiStatelessSource[];
  previous_ai_text: string | null;
};

export type AiStatelessResponse = {
  decision: 'AUTO_REPLY' | 'HUMAN_HANDOFF';
  reply: string | null;
  confidence: number;
  requires_human: boolean;
  handoff_reason: string | null;
  analysis: {
    detected_language: string;
    intent_code: string;
    sentiment?: string | null;
    urgency: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    confidence: number;
  };
  quality_checks: Array<{
    check_type: string;
    passed: boolean;
    score?: number | null;
    findings: Record<string, unknown>;
    checker_version: string;
  }>;
  tool_audits: Array<{
    tool_name: string;
    input: Record<string, unknown>;
    output: unknown;
    status: string;
    error_code?: string | null;
  }>;
  usage: Record<string, number | null>;
  latency_ms: number;
  provider: string;
  model: string;
};

export class AiBackendService {
  async generateStateless(
    tenantId: string,
    payload: AiStatelessRequest,
  ): Promise<AiStatelessResponse> {
    const serviceToken = process.env.AI_SERVICE_TOKEN || '';
    if (!serviceToken) {
      throw new Error('AI_SERVICE_TOKEN is required for autopilot processing.');
    }

    const baseUrl = process.env.AI_BACKEND_URL || 'http://localhost:8083';
    const response = await axios.post(
      new URL('/api/v1/stateless/respond', baseUrl).toString(),
      payload,
      {
        timeout: Number(process.env.AI_REQUEST_TIMEOUT_MS || 45_000),
        headers: {
          'X-Service-Token': serviceToken,
          'X-Tenant-Id': tenantId,
          'Content-Type': 'application/json',
        },
      },
    );
    const result = response.data?.data as AiStatelessResponse | undefined;
    if (!result?.decision) {
      throw new Error('AI Backend returned an invalid stateless response.');
    }
    return result;
  }
}
