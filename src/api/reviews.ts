// Клиент раздела «Отзывы и вопросы» (агент 4): /api/reviews/*.
import type {
  ReviewItem, ReviewView, ReviewsOverview, ReviewSettings, KbFolder, TgPair, KbTextKey,
} from '../../shared/reviews';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/reviews/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    credentials: 'same-origin',
  });
  let j: any = null;
  try { j = await r.json(); } catch { /* пусто */ }
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
  return j as T;
}
const post = <T,>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const reviewsApi = {
  overview: () => call<ReviewsOverview & { ok: true }>('overview'),
  items: (q: { view: ReviewView; mp?: string; kind?: string; rating?: string; q?: string; from?: number; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
    return call<{ total: number; items: ReviewItem[] }>(`items?${p}`);
  },
  draft: (id: number) => post<{ item: ReviewItem }>(`items/${id}/draft`),
  save: (id: number, text: string) => post<{ item: ReviewItem }>(`items/${id}/save`, { text }),
  publish: (id: number, text: string) => post<{ ok: boolean; error?: string; item?: ReviewItem }>(`items/${id}/publish`, { text }),
  skip: (id: number) => post<{ item: ReviewItem }>(`items/${id}/skip`),
  unskip: (id: number) => post<{ item: ReviewItem }>(`items/${id}/unskip`),
  publishBulk: (ids: number[]) => post<{ results: { id: number; ok: boolean; error?: string }[] }>('publish-bulk', { ids }),
  collect: () => post<{ collected: any; drafts: any }>('collect'),
  saveSettings: (patch: Partial<ReviewSettings>) => call<{ settings: ReviewSettings }>('settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  kb: () => call<{
    texts: Record<string, string>; titles: Record<KbTextKey, string>; folders: KbFolder[];
    telegram: { pairs: number; dialogs: number; lastDate: string | null };
    index: { running: boolean; done: number; total: number; current: string | null; error: string | null };
    withoutMaterials: string[];
  }>('kb'),
  saveText: (key: KbTextKey, text: string) => post('kb/text', { key, text }),
  folderText: (path: string) => call<{ text: string }>(`kb/folder?path=${encodeURIComponent(path)}`),
  confirmFolder: (path: string, offerIds: string[]) => post<{ folders: KbFolder[] }>('kb/folder', { path, offerIds }),
  indexDisk: () => post('kb/index'),
  importTg: (pairs: TgPair[]) => post<{ added: number; total: number }>('kb/tg', { pairs }),
  log: () => call<{ log: { at: number; level: string; message: string; data: any }[]; usage: { day: string; purpose: string; cost: number; calls: number }[] }>('log'),
};

// ─── Разбор архива Telegram в браузере ─────────────────────────────────────
// На сервер уходят только пары «вопрос покупателя → ответ магазина», без имён;
// телефоны и @username дополнительно вырезает сервер.
function msgText(t: any): string {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(x => (typeof x === 'string' ? x : x?.text || '')).join('');
  return '';
}

export function parseTelegramExport(json: any): { pairs: TgPair[]; dialogs: number; ownerId: string | null } {
  const chats: any[] = json?.chats?.list ?? (Array.isArray(json?.messages) ? [json] : []);
  const personal = chats.filter(c => !c.type || c.type === 'personal_chat');
  // Владелец аккаунта: из полного экспорта или как отправитель, встречающийся в большинстве чатов.
  let ownerId: string | null = json?.personal_information?.user_id ? `user${json.personal_information.user_id}` : null;
  if (!ownerId) {
    const freq = new Map<string, number>();
    for (const c of personal) {
      const ids = new Set<string>((c.messages || []).map((m: any) => m.from_id).filter(Boolean));
      for (const id of ids) freq.set(id, (freq.get(id) || 0) + 1);
    }
    ownerId = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  const pairs: TgPair[] = [];
  for (const c of personal) {
    let q: string[] = [];
    let a: string[] = [];
    let aId = '';
    let aDate = '';
    const flush = () => {
      if (q.length && a.length) pairs.push({ dialogId: String(c.id), messageId: aId, question: q.join('\n').slice(0, 2000), answer: a.join('\n').slice(0, 2000), date: aDate });
      q = []; a = []; aId = ''; aDate = '';
    };
    for (const m of c.messages || []) {
      if (m.type !== 'message') continue;
      const text = msgText(m.text).trim();
      if (!text) continue;
      if (m.from_id === ownerId) {
        if (!q.length) continue;
        if (!a.length) { aId = String(m.id); aDate = String(m.date || '').slice(0, 10); }
        a.push(text);
      } else {
        if (a.length) flush();
        q.push(text);
      }
    }
    flush();
  }
  return { pairs, dialogs: personal.length, ownerId };
}
