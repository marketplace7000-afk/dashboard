// OAuth client_credentials → bearer для Ozon Performance API.
// Токен живёт ~30 мин, кэшируем централизованно (KV или in-memory).
import { cacheGet, cacheSet } from './cache';

const PERF_HOST = 'https://api-performance.ozon.ru';
const CACHE_KEY = 'ozon-perf:access-token';

type TokenResp = {
  access_token: string;
  expires_in: number;
  token_type?: string;
};

export class OzonPerfAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OzonPerfAuthError';
    this.status = status;
  }
}

export async function getOzonPerfToken(force = false): Promise<string> {
  if (!force) {
    const cached = await cacheGet<{ token: string }>(CACHE_KEY);
    if (cached && Date.now() - cached.fetchedAt < cached.ttlMs - 30_000) {
      return cached.data.token;
    }
  }

  const clientId = process.env.OZON_PERF_CLIENT_ID;
  const clientSecret = process.env.OZON_PERF_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new OzonPerfAuthError('OZON_PERF_CLIENT_ID / OZON_PERF_CLIENT_SECRET не заданы в env');
  }

  const r = await fetch(`${PERF_HOST}/api/client/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new OzonPerfAuthError(`OAuth ${r.status}: ${text.slice(0, 240)}`, r.status);
  }
  const json = await r.json() as TokenResp;
  if (!json.access_token) throw new OzonPerfAuthError('OAuth ответ без access_token');

  // Кэшируем чуть меньше реального expires_in (буфер 60 сек)
  const ttlMs = Math.max(60_000, (json.expires_in - 60) * 1000);
  await cacheSet(CACHE_KEY, { token: json.access_token }, ttlMs);
  return json.access_token;
}

export { PERF_HOST };
