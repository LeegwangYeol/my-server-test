/**
 * Module Export Facade and Key Initialization Helper
 * Target: lib/llm/key-manager/index.ts
 */

export * from './types';
export * from './engine';
export * from './executor';
export { MemoryKeyStore } from './stores/memory';
export { UpstashRedisKeyStore, type UpstashRedisOptions, type UpstashRedisConfig } from './stores/upstash-redis';
export { RotatingLLMProvider, type RotatingProviderOptions } from '../rotating-provider';

import type { IKeyStore, KeyConfig } from './types';
import { MemoryKeyStore } from './stores/memory';
import { UpstashRedisKeyStore } from './stores/upstash-redis';

export interface KeyManagerInstance {
  keyStore: IKeyStore;
  keyConfigMap: Map<string, KeyConfig>;
  keys: KeyConfig[];
}

export interface InitializeKeyManagerOptions {
  keys?: KeyConfig[];
  envKeysJson?: string;
  envKeysCsv?: string;
  singleApiKey?: string;
  redisUrl?: string;
  redisToken?: string;
  forceMemoryStore?: boolean;
}

/**
 * Parses raw environment variables into strongly-typed KeyConfig definitions.
 */
export function parseKeyConfigsFromEnv(env: Record<string, string | undefined> = process.env): KeyConfig[] {
  // Option 1: Structured JSON array in OPENROUTER_API_KEYS
  const rawJson = env.OPENROUTER_API_KEYS?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item, idx) => ({
          id: item.id || `key-${idx}`,
          apiKey: item.apiKey || String(item),
          tier: typeof item.tier === 'number' ? item.tier : (idx === 0 ? 0 : 1),
          weight: typeof item.weight === 'number' && item.weight > 0 ? item.weight : 10,
          maxConcurrency: typeof item.maxConcurrency === 'number' && item.maxConcurrency > 0 ? item.maxConcurrency : 10,
          accountId: item.accountId || undefined,
        }));
      }
    } catch (err) {
      console.warn('[KeyManager] Failed to parse OPENROUTER_API_KEYS as JSON:', err);
    }
  }

  // Option 2: Comma-separated keys in LLM_API_KEYS
  const rawCsv = env.LLM_API_KEYS?.trim();
  if (rawCsv) {
    const tokens = rawCsv.split(',').map((t) => t.trim()).filter(Boolean);
    if (tokens.length > 0) {
      return tokens.map((keyStr, idx) => ({
        id: `key-${idx}`,
        apiKey: keyStr,
        tier: idx === 0 ? 0 : 1, // First is primary, rest are secondary
        weight: idx === 0 ? 10 : 5,
        maxConcurrency: 10,
        accountId: undefined,
      }));
    }
  }

  // Option 3: Single key in LLM_API_KEY (can also be comma-separated)
  const singleKey = env.LLM_API_KEY?.trim();
  if (singleKey) {
    if (singleKey.includes(',')) {
      const tokens = singleKey.split(',').map((t) => t.trim()).filter(Boolean);
      return tokens.map((keyStr, idx) => ({
        id: `key-${idx}`,
        apiKey: keyStr,
        tier: idx === 0 ? 0 : 1,
        weight: idx === 0 ? 10 : 5,
        maxConcurrency: 10,
        accountId: undefined,
      }));
    }
    return [
      {
        id: 'default',
        apiKey: singleKey,
        tier: 0,
        weight: 10,
        maxConcurrency: 10,
        accountId: undefined,
      },
    ];
  }

  return [];
}

/**
 * Initializes the Key Manager subsystem, syncing keys and resolving storage.
 */
export async function initializeKeyManager(
  options: InitializeKeyManagerOptions = {}
): Promise<KeyManagerInstance> {
  // 1. Resolve keys
  let keys = options.keys;
  if (!keys || keys.length === 0) {
    keys = parseKeyConfigsFromEnv({
      OPENROUTER_API_KEYS: options.envKeysJson ?? process.env.OPENROUTER_API_KEYS,
      LLM_API_KEYS: options.envKeysCsv ?? process.env.LLM_API_KEYS,
      LLM_API_KEY: options.singleApiKey ?? process.env.LLM_API_KEY,
    });
  }

  // 2. Resolve storage implementation
  const redisUrl = (options.redisUrl ?? process.env.UPSTASH_REDIS_REST_URL)?.trim();
  const redisToken = (options.redisToken ?? process.env.UPSTASH_REDIS_REST_TOKEN)?.trim();

  let keyStore: IKeyStore;
  if (!options.forceMemoryStore && redisUrl && redisToken) {
    keyStore = new UpstashRedisKeyStore(redisUrl, redisToken);
  } else {
    keyStore = new MemoryKeyStore();
  }

  // 3. Seed keys into store
  if (keys.length > 0) {
    await keyStore.syncKeys(keys);
  }

  const keyConfigMap = new Map<string, KeyConfig>(keys.map((k) => [k.id, k]));

  return {
    keyStore,
    keyConfigMap,
    keys,
  };
}
