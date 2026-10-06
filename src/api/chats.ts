// Клиент раздела «Чаты с покупателями» (WB): /api/reviews/chats/*.
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
  list: (view: ChatView, q = '', offset = 0) =>
    call<{ total: number; threads: ChatThread[]; counts: { waiting: number; drafts: number }; totals: { threads: number; messages: number } }>(
      `?view=${view}&q=${encodeURIComponent(q)}&limit=60&offset=${offset}`),
  thread: (id: string) => call<{ thread: ChatThread; messages: ChatMsg[] }>(`/thread?id=${encodeURIComponent(id)}`),
  draft: (id: string) => post<{ thread: ChatThread }>('/thread/draft', { id }),
  save: (id: string, text: string) => post<{ thread: ChatThread }>('/thread/save', { id, text }),
  send: (id: string, text: string) => post<{ ok: boolean; error?: string; thread?: ChatThread }>('/thread/send', { id, text }),
  skip: (id: string) => post<{ thread: ChatThread }>('/thread/skip', { id }),
  unskip: (id: string) => post<{ thread: ChatThread }>('/thread/unskip', { id }),
  sync: () => post<{ result: any }>('/sync', {}),
  counts: () => call<{ waiting: number; drafts: number }>('/counts'),
};
