import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const commonOptions = {
    maxRetriesPerRequest: null,
    // Add family: 0 to fallback between IPv4/IPv6 (helps with Upstash/Railway)
    family: 0,
    // Stability settings for cloud Redis
    connectTimeout: 20000,
    keepAlive: 10000, // Send keepalive every 10s
    retryStrategy(times: number) {
        // Linear backoff: 50ms, 100ms, 150ms... maxing at 2s
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    // Fail-fast if connection is down, don't queue commands indefinitely
    enableOfflineQueue: false,
    // Timeout individual commands after 5s
    commandTimeout: 5000,
};

let redisClient: Redis;

if (process.env.REDIS_URL) {
    redisClient = new Redis(process.env.REDIS_URL, {
        ...commonOptions,
        // Explicitly enable TLS if using rediss protocol
        tls: process.env.REDIS_URL.startsWith('rediss://') ? {
            rejectUnauthorized: false
        } : undefined,
    });
} else if (process.env.REDISHOST) {
    // Railway Internal Redis
    redisClient = new Redis({
        ...commonOptions,
        host: process.env.REDISHOST,
        port: parseInt(process.env.REDISPORT || '6379', 10),
        username: process.env.REDISUSER,
        password: process.env.REDISPASSWORD,
    });
} else {
    console.warn('⚠️  REDIS_URL and REDISHOST are missing. Defaulting to localhost.');
    redisClient = new Redis('redis://localhost:6379', commonOptions);
}

export const redis = redisClient;

redis.on('connect', () => {
    console.log('📡 Connected to Redis');
});

redis.on('error', (err: Error) => {
    console.error('❌ Redis connection error:', err);
});
