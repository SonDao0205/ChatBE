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
  customer_profile: Record<string, unknown>;
  response_strategy: Record<string, unknown>;
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

export type CustomerProfileAnalysis = {
  profile_summary: string;
  features: Record<string, unknown>;
  lead_priority: {
    code: 'HOT_LEAD' | 'WARM_LEAD' | 'COLD_LEAD' | 'EXISTING_PRIORITY';
    score: number;
    reason: string;
    evidence_message_ids: string[];
  };
  confidence: number;
  model_version: string;
};

export class AiBackendService {
  async analyzeCustomerProfile(
    tenantId: string,
    payload: {
      customer_id: string;
      existing_profile: Record<string, unknown>;
      messages: Array<{ id: string; sender_type: string; text_content: string }>;
      recent_orders: Array<Record<string, unknown>>;
    },
  ): Promise<CustomerProfileAnalysis> {
    const serviceToken = process.env.AI_SERVICE_TOKEN || '';
    if (!serviceToken) throw new Error('AI_SERVICE_TOKEN is required.');
    const baseUrl = process.env.AI_BACKEND_URL || 'http://localhost:8083';
    const response = await axios.post(
      new URL('/api/v1/stateless/customer-profile', baseUrl).toString(),
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
    const result = response.data?.data as CustomerProfileAnalysis | undefined;
    if (!result?.lead_priority?.code) {
      throw new Error('AI Backend returned an invalid customer profile.');
    }
    return result;
  }

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
