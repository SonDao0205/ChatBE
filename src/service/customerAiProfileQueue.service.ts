import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createRedisConnection } from '../config/redis';
import { customerAiProfileService } from './customerAiProfile.service';

export type CustomerAiProfileJob = {
  tenantId: string;
  marketplaceCustomerId: string;
  marketplaceAccountId: string;
  messageId: string;
};

const queueName = 'customer-ai-profile-update';
let queueConnection: IORedis | null = null;
let workerConnection: IORedis | null = null;
let queue: Queue<CustomerAiProfileJob> | null = null;
let worker: Worker<CustomerAiProfileJob> | null = null;

function getQueue() {
  if (!queueConnection) queueConnection = createRedisConnection();
  if (!queue) {
    queue = new Queue<CustomerAiProfileJob>(queueName, {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 },
      },
    });
  }
  return queue;
}

export async function enqueueCustomerAiProfile(data: CustomerAiProfileJob) {
  const profileQueue = getQueue();
  const delay = Number(process.env.CUSTOMER_PROFILE_DEBOUNCE_MS || 5_000);
  let jobId = `customer-${data.marketplaceCustomerId}`;
  const existing = await profileQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed') {
      await existing.updateData(data);
      await existing.changeDelay(delay);
      return existing;
    }
    if (state === 'waiting' || state === 'waiting-children') {
      await existing.updateData(data);
      return existing;
    }
    if (state === 'completed' || state === 'failed') await existing.remove();
    if (state === 'active') jobId = `${jobId}-${data.messageId}`;
  }
  return profileQueue.add('update-customer-profile', data, {
    jobId,
    delay,
    removeOnComplete: true,
  });
}

export async function startCustomerAiProfileWorker() {
  if (worker) return worker;
  workerConnection = createRedisConnection();
  worker = new Worker<CustomerAiProfileJob>(
    queueName,
    async (job) => customerAiProfileService.refresh(
      job.data.tenantId,
      job.data.marketplaceCustomerId,
      job.data.marketplaceAccountId,
    ),
    { connection: workerConnection, concurrency: 2 },
  );
  worker.on('failed', (job, error) => {
    console.error('Customer AI profile job failed', {
      jobId: job?.id,
      marketplaceCustomerId: job?.data.marketplaceCustomerId,
      error: error.message,
    });
  });
  await worker.waitUntilReady();
  return worker;
}

export async function closeCustomerAiProfileQueue() {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
  await workerConnection?.quit();
  await queueConnection?.quit();
  workerConnection = null;
  queueConnection = null;
}
