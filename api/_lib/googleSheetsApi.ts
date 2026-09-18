/**
 * Чтение Google-таблиц через СЕРВИСНЫЙ АККАУНТ (Sheets API v4).
 *
 * Зачем, если уже есть Apps Script: скрипт надо разворачивать в каждой таблице
 * руками, и владелец таблицы должен это сделать сам. С сервисным аккаунтом
 * клиенту достаточно нажать «Поделиться» и добавить один e-mail на просмотр —
 * то же, что он делает для любого коллеги. Для мультиарендности это
 * единственный вменяемый путь: у каждого селлера своя таблица, и просить всех
 * ставить скрипты нереально.
 *
 * Библиотек не тянем: нужен один подписанный JWT и один POST за токеном.
 *
 * Настройка (см. docs):
 *   GOOGLE_SA_KEY_FILE=/opt/autovibe/av-data/google-sa.json   — файл ключа
 *   (или GOOGLE_SA_KEY_JSON — то же содержимое строкой)
 * Файл ключа — это секрет: он лежит в av-data, который не попадает ни в git,
 * ни в rsync.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

type ServiceAccount = { client_email: string; private_key: string };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

let cachedSa: ServiceAccount | null | undefined;
let token: { value: string; expiresAt: number } | null = null;

function loadServiceAccount(): ServiceAccount | null {
  if (cachedSa !== undefined) return cachedSa;
  try {
    const inline = (process.env.GOOGLE_SA_KEY_JSON || '').trim();
    const file = (process.env.GOOGLE_SA_KEY_FILE || '').trim();
    const raw = inline || (file ? readFileSync(file, 'utf8') : '');
    if (!raw) { cachedSa = null; return null; }
    const j = JSON.parse(raw);
    if (!j?.client_email || !j?.private_key) throw new Error('в ключе нет client_email/private_key');
    cachedSa = { client_email: j.client_email, private_key: String(j.private_key).replace(/\\n/g, '\n') };
    return cachedSa;
  } catch (e) {
    console.warn('[sheets-api] ключ сервисного аккаунта не прочитан:', (e as Error).message);
    cachedSa = null;
    return null;
  }
}

/** Есть ли вообще настроенный доступ — чтобы честно сказать «не подключено». */
export function hasServiceAccount(): boolean {
  return !!loadServiceAccount();
}

/** E-mail, который клиент должен добавить в доступ к своей таблице. */
export function serviceAccountEmail(): string | null {
  return loadServiceAccount()?.client_email ?? null;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getAccessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const sa = loadServiceAccount();
  if (!sa) throw new Error('сервисный аккаунт не настроен');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(sa.private_key));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) {
    throw new Error(`токен не получен: ${res.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  }
  token = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return token.value;
}

/**
 * Строки диапазона. range в нотации A1: «Склад!A1:Z5000».
 * Пустые хвостовые ячейки Google не присылает, поэтому строки бывают короче —
 * читатели обязаны это учитывать (обращение по индексу может дать undefined).
 */
export async function readSheetRange(spreadsheetId: string, range: string): Promise<any[][]> {
  const access = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
    + `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${access}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    // 403 здесь почти всегда значит «таблицей не поделились с сервисным аккаунтом»
    throw new Error(`Sheets API ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j: any = await res.json();
  return j?.values ?? [];
}

/** Названия вкладок таблицы — чтобы не падать на 400, когда лист переименовали. */
export async function listSheetTitles(spreadsheetId: string): Promise<string[]> {
  const access = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await res.json();
  return (j?.sheets ?? []).map((sh: any) => String(sh?.properties?.title ?? '')).filter(Boolean);
}
