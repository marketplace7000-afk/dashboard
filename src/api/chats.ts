// Клиент раздела «Чаты с покупателями» (WB и Ozon): /api/reviews/chats/*.
export type ChatThread = {
  marketplace: 'wb' | 'ozon'; chatId: string; clientName: string | null; sku: string | null; offerId: string | null;
  productName: string | null; lastAt: number | null; lastFromBuyer: boolean; lastText: string | null;
  status: 'idle' | 'new' | 'drafted' | 'escalated' | 'sent' | 'skipped';
  draftAnswer: string | null; draftModel: string | null; draftCostUsd: number | null; draftFor: string | null;
  confidence: string | null; escalationReason: string | null; sourcesUsed: string[];
  sentAt: number | null; sentBy: string | null; sendError: string | null; canReply: boolean;
};
export type ChatMsg = { id: string; at: number; fromBuyer: boolean; text: string };
export type ChatView = 'waiting' | 'drafts' | 'all';
export type ChatMp = 'all' | 'wb' | 'ozon';
export type ChatCounts = { waiting: number; drafts: number; wb: { waiting: number; drafts: number }; ozon: { waiting: number; drafts: number } };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/reviews/chats${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    credentials: 'same-origin',
  });
  let j: any = null;
  try { j = await r.json(); } catch { /* пусто */ }
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
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
  counts: () => call<ChatCounts>('/counts'),
};
