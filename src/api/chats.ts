// Клиент раздела «Чаты с покупателями» (WB и Ozon): /api/reviews/chats/*.
import { notifyUnauthorized } from './http';
export type ChatThread = {
  marketplace: 'wb' | 'ozon'; chatId: string; clientName: string | null; sku: string | null; offerId: string | null;
  productName: string | null; lastAt: number | null; lastFromBuyer: boolean; lastText: string | null;
  status: 'idle' | 'new' | 'drafted' | 'escalated' | 'sent' | 'skipped' | 'closed';
  draftAnswer: string | null; draftModel: string | null; draftCostUsd: number | null; draftFor: string | null;
  confidence: string | null; escalationReason: string | null; sourcesUsed: string[];
  sentAt: number | null; sentBy: string | null; sendError: string | null; canReply: boolean;
  productPhoto?: string | null; productUrl?: string | null;
};
export type ChatMedia = { id: number; kind: 'photo' | 'video'; note: string | null; viewable: boolean; error: string | null };
export type ChatMsg = { id: string; at: number; fromBuyer: boolean; text: string; media?: ChatMedia[] };
export type ChatView = 'waiting' | 'drafts' | 'all';
export type ChatDoc = {
  id: string; name: string; folder: string;
  category: 'Инструкция' | 'Техпаспорт' | 'Сертификат' | 'Комплектация' | 'Характеристики' | 'Другое';
  english: boolean; ext: string; size: number | null; chatOk: boolean; source: 'disk' | 'upload'; offerId?: string | null;
};
export type ChatDocsOverview = {
  docs: ChatDoc[]; emails: string[];
  log: { at: number; channel: string; names: string[]; to: string | null; ok: boolean; error: string | null }[];
  mail: { ready: boolean; from: string | null }; diskConnected: boolean;
  mailDefault: { subject: string; text: string };
};
export type DocSendResult = { ok: boolean; sent: string[]; errors: string[]; error?: string };
export type ChatMp = 'all' | 'wb' | 'ozon';
export type ChatCounts = { waiting: number; drafts: number; wb: { waiting: number; drafts: number }; ozon: { waiting: number; drafts: number } };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/reviews/chats${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    credentials: 'same-origin',
  });
  notifyUnauthorized(r.status);   // сессия истекла — на экран входа, а не «HTTP 401»
  let j: any = null;
  try { j = await r.json(); } catch { /* пусто */ }
  // Успешный код, но не JSON (заглушка nginx при перезапуске) — понятная ошибка, а не null дальше по коду.
  if (r.ok && j == null) throw new Error('сервер вернул не данные — возможно, он перезапускается; попробуйте через минуту');
  if (!r.ok || j?.ok === false) throw new Error(j?.reason || j?.error || (r.status === 401 ? 'сессия истекла — нужно войти заново' : `сервер ответил ${r.status}`));
  return j as T;
}
const post = <T,>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const chatsApi = {
  list: (view: ChatView, mp: ChatMp, q = '', offset = 0) =>
    call<{ total: number; threads: ChatThread[]; counts: ChatCounts; totals: { threads: number; messages: number; wb: number; ozon: number } }>(
      `?view=${view}&mp=${mp === 'all' ? '' : mp}&q=${encodeURIComponent(q)}&limit=60&offset=${offset}`),
  thread: (mp: string, id: string) => call<{ thread: ChatThread; messages: ChatMsg[] }>(`/thread?mp=${mp}&id=${encodeURIComponent(id)}`),
  draft: (mp: string, id: string) => post<{ thread: ChatThread }>('/thread/draft', { mp, id }),
  save: (mp: string, id: string, text: string) => post<{ thread: ChatThread }>('/thread/save', { mp, id, text }),
  send: (mp: string, id: string, text: string) => post<{ ok: boolean; error?: string; thread?: ChatThread }>('/thread/send', { mp, id, text }),
  skip: (mp: string, id: string) => post<{ thread: ChatThread }>('/thread/skip', { mp, id }),
  unskip: (mp: string, id: string) => post<{ thread: ChatThread }>('/thread/unskip', { mp, id }),
  sync: () => post<{ result: any }>('/sync', {}),
  // Документы для покупателя (инструкции, техпаспорта) — 20.11.2026.
  docs: (mp: string, id: string) => call<ChatDocsOverview>(`/docs?mp=${mp}&id=${encodeURIComponent(id)}`),
  searchDocs: (q: string) => call<{ docs: ChatDoc[] }>(`/docs?q=${encodeURIComponent(q)}`),
  docUrl: (docId: string) => `/api/reviews/chats/docs/file?doc=${encodeURIComponent(docId)}`,
  sendDocs: (mp: string, id: string, docs: string[]) => post<DocSendResult>('/thread/send-docs', { mp, id, docs }),
  emailDocs: (mp: string, id: string, docs: string[], to: string, text: string) => post<DocSendResult>('/thread/email-docs', { mp, id, docs, to, text }),
  deleteDoc: (doc: string) => post<{ ok: boolean }>('/docs/delete', { doc }),
  uploadDoc: async (file: File, offerId: string | null): Promise<{ doc: ChatDoc }> => {
    const r = await fetch(`/api/reviews/chats/docs/upload?name=${encodeURIComponent(file.name)}&offer=${encodeURIComponent(offerId || '')}`, {
      method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin',
    });
    notifyUnauthorized(r.status);
    let j: any = null;
    try { j = await r.json(); } catch { /* не JSON */ }
    if (r.status === 413) throw new Error('файл больше 10 МБ — положите его в папку товара на Яндекс.Диске');
    if (!r.ok || !j?.ok) throw new Error(j?.error || `сервер ответил ${r.status}`);
    return j;
  },
  counts: () => call<ChatCounts>('/counts'),
};
