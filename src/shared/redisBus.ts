import { createClient, RedisClientType } from 'redis';
import config from './config';
import logger from './logger';

export type MessageHandler = (channel: string, message: string) => void | Promise<void>;

export class RedisBus {
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private connected = false;
  private handlers = new Map<string, MessageHandler[]>();

  constructor() {
    this.publisher = createClient({ url: config.redisUrl });
    this.subscriber = createClient({ url: config.redisUrl });

    this.publisher.on('error', (err) => logger.error('Redis publisher error', { err }));
    this.subscriber.on('error', (err) => logger.error('Redis subscriber error', { err }));
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.publisher.connect();
    await this.subscriber.connect();
    this.connected = true;
    logger.info('Redis bus connected');
  }

  async disconnect(): Promise<void> {
    await this.publisher.quit();
    await this.subscriber.quit();
    this.connected = false;
  }

  async publish(channel: string, message: unknown): Promise<void> {
    if (!this.connected) await this.connect();
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    if (!this.connected) await this.connect();
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, []);
      await this.subscriber.subscribe(channel, (msg) => {
        this.handlers.get(channel)?.forEach((h) => {
          try {
            h(channel, msg);
          } catch (err) {
            logger.error('Redis message handler error', { channel, err });
          }
        });
      });
    }
    this.handlers.get(channel)!.push(handler);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.connected) await this.connect();
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.publisher.setEx(key, ttlSeconds, serialized);
    } else {
      await this.publisher.set(key, serialized);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.connected) await this.connect();
    const value = await this.publisher.get(key);
    if (value === null) return null;
    return JSON.parse(value) as T;
  }

  async del(key: string): Promise<void> {
    if (!this.connected) await this.connect();
    await this.publisher.del(key);
  }
}

export const redisBus = new RedisBus();
export default redisBus;
