import dotenv from 'dotenv';
import IORedis from 'ioredis';

dotenv.config();

export function createRedisConnection() {
  return new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379/0', {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
