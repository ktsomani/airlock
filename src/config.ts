import 'dotenv/config';
import { resolve } from 'node:path';
import { fail } from './core.js';
export const DEV_SECRET = 'airlock-dev-only-change-me';
export function config(env = process.env) {
  const mode = env.PAPER_MCP_MODE ?? 'mock';
  if (!['mock', 'live'].includes(mode)) fail('invalid_mode');
  const secret = env.AIRLOCK_APPROVAL_SECRET ?? DEV_SECRET;
  if (mode === 'live' && env.AIRLOCK_LIVE_CONFIRM !== '1') fail('live_confirmation_required');
  if (mode === 'live' && (secret === DEV_SECRET || secret.trim().length < 32))
    fail(
      'unsafe_approval_secret',
      'Live mode requires a non-default approval secret of at least 32 characters.',
    );
  const numeric = (key: string, fallback: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isFinite(n) || n <= 0) fail('invalid_config', key);
    return n;
  };
  let headers: Record<string, string>;
  try {
    headers = JSON.parse(env.PAPER_MCP_HEADERS ?? '{}');
  } catch {
    return fail('invalid_headers');
  }
  if (
    !headers ||
    Array.isArray(headers) ||
    typeof headers !== 'object' ||
    Object.values(headers).some((v) => typeof v !== 'string')
  )
    fail('invalid_headers');
  return {
    mode: mode as 'mock' | 'live',
    secret,
    endpoint: env.PAPER_MCP_ENDPOINT ?? 'http://127.0.0.1:29979/mcp',
    headers,
    timeout: numeric('PAPER_MCP_CONNECT_TIMEOUT_MS', 8000),
    ttl: numeric('SCHEMA_CACHE_TTL_MINUTES', 60) * 60000,
    dataDir: resolve(env.AIRLOCK_DATA_DIR ?? '.airlock'),
    port: numeric('AIRLOCK_PORT', 4317),
    adapterPath: env.AIRLOCK_ADAPTER,
  };
}
export type Config = ReturnType<typeof config>;
