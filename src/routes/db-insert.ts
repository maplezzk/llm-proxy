import { sql } from 'drizzle-orm';
import { log } from '../lib/logger.js';
import { loadEnv } from '../config/env.js';
import { getDb } from '../db/client.js';
import type { Context } from 'hono';

const ROUTE = 'GET /db/insert';
const PROBE_MODEL = 'p0-probe';
const PROBE_PROVIDER = 'p0-probe';
const PROBE_STATUS = 200;

export const handleDbInsert = async (c: Context): Promise<Response> => {
  if (!loadEnv().DATABASE_URL) {
    return c.json({ ok: false, route: ROUTE, reason: 'DATABASE_URL not set' }, 503);
  }
  try {
    const rows = await getDb().execute<{ id: number }>(
      sql`INSERT INTO requests (model, provider, status) VALUES (${PROBE_MODEL}, ${PROBE_PROVIDER}, ${PROBE_STATUS}) RETURNING id`,
    );
    return c.json({ ok: true, route: ROUTE, rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, route: ROUTE }, 'db insert failed');
    return c.json({ ok: false, route: ROUTE, error: 'db insert failed; see server log' }, 500);
  }
};
