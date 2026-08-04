import { Queue, Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { createRedisConnection } from '../config/redis';
import {
  AiAutopilotWorkerService,
  type AiAutopilotJob,
} from './aiAutopilotWorker.service';

const queueName = 'ai-autopilot-inbound-messages';
let queueConnection: IORedis | null = null;
let workerConnection: IORedis | null = null;
let queue: Queue<AiAutopilotJob> | null = null;
let worker: Worker<AiAutopilotJob> | null = null;

function getQueue() {
  if (!queueConnection) queueConnection = createRedisConnection();
  if (!queue) {
    queue = new Queue<AiAutopilotJob>(queueName, {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: Number(process.env.AI_JOB_ATTEMPTS || 2),
        backoff: {
          type: 'exponential',
          delay: Number(process.env.AI_JOB_BACKOFF_MS || 1_000),
        },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 },
      },
    });
  }
  return queue;
}

export async function enqueueAiAutopilot(data: AiAutopilotJob) {
  return getQueue().add('respond-to-inbound-message', data, {
    jobId: data.messageId,
    delay: Number(process.env.AI_AUTOPILOT_DEBOUNCE_MS || 750),
  });
}

export async function startAiAutopilotWorker() {
  if (worker) return worker;
  workerConnection = createRedisConnection();
  const service = new AiAutopilotWorkerService();
  worker = new Worker<AiAutopilotJob>(
    queueName,
    async (job) => service.process(job),
    {
      connection: workerConnection,
      concurrency: Math.max(1, Number(process.env.AI_WORKER_CONCURRENCY || 4)),
    },
  );
  worker.on('completed', (job, result) => {
    console.info('AI autopilot job completed', {
      jobId: job.id,
      conversationId: job.data.conversationId,
      result,
    });
  });
  worker.on('failed', (job: Job<AiAutopilotJob> | undefined, error) => {
    console.error('AI autopilot job failed', {
      jobId: job?.id,
      conversationId: job?.data.conversationId,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    });
    if (!job) return;
    const configuredAttempts = Number(job.opts.attempts || 1);
    if (job.attemptsMade >= configuredAttempts) {
      void service.handleFinalFailure(job, error).catch((handoffError: unknown) => {
        console.error('Cannot hand off permanently failed AI job:', handoffError);
      });
    }
  });
  await worker.waitUntilReady();
  return worker;
}

export async function closeAiAutopilotQueue() {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
  await workerConnection?.quit();
  await queueConnection?.quit();
  workerConnection = null;
  queueConnection = null;
}

export async function pingAiQueueRedis() {
  getQueue();
  return queueConnection!.ping();
}
