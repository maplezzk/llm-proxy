/**
 * Unit tests: covers schemas in use and loadEnv contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z, type ZodIssue } from 'zod';
import { loadEnv, resetEnvCache } from '../src/config/env.js';

const sseQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(50).default(5),
  intervalMs: z.coerce.number().int().min(0).max(2000).default(100),
});

const toIssuePaths = (issues: ZodIssue[]): string[] =>
  issues.map((i) => i.path.join('.'));

describe('sseQuerySchema', () => {
  it('should apply defaults for an empty query', () => {
    const parsed = sseQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.count).toBe(5);
      expect(parsed.data.intervalMs).toBe(100);
    }
  });

  it('should coerce string numerics', () => {
    const parsed = sseQuerySchema.safeParse({ count: '3', intervalMs: '20' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.count).toBe(3);
      expect(parsed.data.intervalMs).toBe(20);
    }
  });

  it('should reject count above max', () => {
    const parsed = sseQuerySchema.safeParse({ count: '999' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(toIssuePaths(parsed.error.issues)).toContain('count');
    }
  });

  it('should reject negative intervalMs', () => {
    const parsed = sseQuerySchema.safeParse({ intervalMs: '-1' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(toIssuePaths(parsed.error.issues)).toContain('intervalMs');
    }
  });
});

describe('loadEnv contract', () => {
  beforeEach(() => resetEnvCache());
  afterEach(() => resetEnvCache());

  it('should accept a minimal env and fill defaults', () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(9000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NODE_ENV).toBe('production');
  });

  it('should reject out-of-range PORT', () => {
    expect(() => loadEnv({ PORT: '99999' })).toThrow(/env validation failed/);
  });

  it('should reject invalid LOG_LEVEL enum', () => {
    expect(() => loadEnv({ LOG_LEVEL: 'verbose' })).toThrow(/env validation failed/);
  });
});
