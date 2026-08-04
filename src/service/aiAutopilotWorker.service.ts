import axios from 'axios';
import type { Job } from 'bullmq';
import { AiBackendService } from './aiBackend.service';
import { AiAutopilotContextService } from './aiAutopilotContext.service';
import { AiAutopilotPersistenceService } from './aiAutopilotPersistence.service';
import { MarketplaceMessageSenderService } from './marketplaceMessageSender.service';

export type AiAutopilotJob = {
  tenantId: string;
  conversationId: string;
  messageId: string;
};

const terminalStatuses = new Set(['SENT', 'HANDED_OFF']);

export class AiAutopilotWorkerService {
  private readonly aiBackend = new AiBackendService();
  private readonly context = new AiAutopilotContextService();
  private readonly persistence = new AiAutopilotPersistenceService();
  private readonly messageSender = new MarketplaceMessageSenderService();

  async process(job: Job<AiAutopilotJob>) {
    const data = job.data;
    const idempotencyKey = `autopilot:${data.messageId}`;
    const loaded = await this.context.load({
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      requestId: data.messageId,
    });
    if (!loaded || loaded.aiMode !== 'AUTO') {
      return { status: 'SKIPPED', reason: 'AI mode is not AUTO or message is invalid.' };
    }
    if (loaded.lastMessageId !== data.messageId) {
      return { status: 'SKIPPED', reason: 'A newer message superseded this job.' };
    }

    const run = await this.persistence.beginRun({
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      idempotencyKey,
    });
    if (terminalStatuses.has(run.status)) {
      return { status: run.status, runId: run.id, replay: true };
    }

    if (loaded.humanRespondedAfterTrigger) {
      await this.persistence.markFailed({
        tenantId: data.tenantId,
        idempotencyKey,
        errorCode: 'HUMAN_ALREADY_RESPONDED',
        reason: 'Nhân viên đã trả lời sau tin nhắn kích hoạt AI.',
      });
      await this.persistence.handoff({
        tenantId: data.tenantId,
        conversationId: data.conversationId,
        runId: run.id,
        reasonCode: 'HUMAN_ALREADY_RESPONDED',
        reasonText: 'Nhân viên đã tham gia hội thoại; AI tự động đã được tắt.',
        priority: 'NORMAL',
      });
      return { status: 'HUMAN_HANDOFF', runId: run.id };
    }

    if (loaded.tokensUsed >= loaded.tokenLimit) {
      await this.persistence.markFailed({
        tenantId: data.tenantId,
        idempotencyKey,
        errorCode: 'AI_TOKEN_QUOTA_EXHAUSTED',
        reason: 'Tenant đã sử dụng hết hạn mức token AI trong tháng.',
      });
      await this.persistence.handoff({
        tenantId: data.tenantId,
        conversationId: data.conversationId,
        runId: run.id,
        reasonCode: 'AI_TOKEN_QUOTA_EXHAUSTED',
        reasonText: 'AI đã hết hạn mức token. Hội thoại được chuyển cho nhân viên.',
        priority: 'HIGH',
      });
      return { status: 'HUMAN_HANDOFF', runId: run.id };
    }

    let response;
    try {
      response = await this.aiBackend.generateStateless(
        data.tenantId,
        loaded.payload,
      );
    } catch (error) {
      if (this.isNonRetryableProviderFailure(error)) {
        const reason = this.errorMessage(error);
        await this.persistence.markFailed({
          tenantId: data.tenantId,
          idempotencyKey,
          errorCode: this.errorCode(error),
          reason,
        });
        await this.persistence.handoff({
          tenantId: data.tenantId,
          conversationId: data.conversationId,
          runId: run.id,
          reasonCode: this.errorCode(error),
          reasonText: `AI không thể tiếp tục tự động: ${reason}`,
          priority: 'HIGH',
        });
        return { status: 'HUMAN_HANDOFF', runId: run.id };
      }
      throw error;
    }

    await this.persistence.saveAiResult({
      tenantId: data.tenantId,
      runId: run.id,
      request: loaded.payload,
      response,
    });
    if (response.decision === 'HUMAN_HANDOFF' || !response.reply?.trim()) {
      await this.persistence.handoff({
        tenantId: data.tenantId,
        conversationId: data.conversationId,
        runId: run.id,
        reasonCode: 'AI_REQUIRES_HUMAN',
        reasonText:
          response.handoff_reason || 'AI đánh giá tình huống cần nhân viên xử lý.',
        priority:
          response.analysis.urgency === 'URGENT' ? 'URGENT' : 'HIGH',
      });
      return { status: 'HUMAN_HANDOFF', runId: run.id };
    }

    const sendGuard = await this.context.getSendGuard({
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      triggerCreatedAt: loaded.triggerCreatedAt,
    });
    if (sendGuard !== 'READY') {
      await this.persistence.markRejected({
        tenantId: data.tenantId,
        runId: run.id,
        reason: `AI response was not sent because send guard returned ${sendGuard}.`,
      });
      if (sendGuard === 'HUMAN_RESPONDED') {
        await this.persistence.handoff({
          tenantId: data.tenantId,
          conversationId: data.conversationId,
          runId: run.id,
          reasonCode: 'HUMAN_ALREADY_RESPONDED',
          reasonText: 'Nhân viên đã trả lời trước khi AI gửi tin.',
          priority: 'NORMAL',
        });
      }
      return { status: 'SKIPPED', runId: run.id, reason: sendGuard };
    }

    const message = await this.messageSender.sendSellerMessage({
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      text: response.reply,
      senderType: 'AI',
      aiResponseRunId: run.id,
      idempotencyKey: `ai-autopilot-${run.id}`,
    });
    await this.persistence.markSent({
      tenantId: data.tenantId,
      runId: run.id,
      outputMessageId: message.id,
    });
    return { status: 'SENT', runId: run.id, messageId: message.id };
  }

  async handleFinalFailure(job: Job<AiAutopilotJob>, error: Error) {
    const idempotencyKey = `autopilot:${job.data.messageId}`;
    await this.persistence.markFailed({
      tenantId: job.data.tenantId,
      idempotencyKey,
      errorCode: 'AI_AUTOPILOT_UNAVAILABLE',
      reason: error.message,
    });
    await this.persistence.handoff({
      tenantId: job.data.tenantId,
      conversationId: job.data.conversationId,
      reasonCode: 'AI_AUTOPILOT_UNAVAILABLE',
      reasonText: 'AI không phản hồi sau các lần thử lại. Hội thoại đã chuyển cho nhân viên.',
      priority: 'HIGH',
    });
  }

  private isNonRetryableProviderFailure(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    return status === 400 || status === 401 || status === 403 || status === 422 || status === 429;
  }

  private errorCode(error: unknown) {
    if (!axios.isAxiosError(error)) return 'AI_REQUEST_FAILED';
    if (error.response?.status === 429) return 'AI_TOKEN_OR_RATE_LIMIT_EXHAUSTED';
    return `AI_HTTP_${error.response?.status || 'ERROR'}`;
  }

  private errorMessage(error: unknown) {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : 'AI request failed.';
    }
    const data = error.response?.data as { message?: string; detail?: string } | undefined;
    return data?.message || data?.detail || error.message;
  }
}
