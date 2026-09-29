/**
 * Клиент для /api/ai/chat — AI-копилот с контекстом бизнеса.
 * История переписки хранится в localStorage (общая лента, без тредов).
 */
import { readOzonPerfCache, parseRu } from './ozonAds';
import { localDateStr } from './marketplaces';
import { noteSwallowed } from '../utils/log';

export type ChatRole = 'user' | 'assistant';
export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
};

const LS_KEY = 'ai-chat:history:v1';
const MAX_HISTORY = 100;

export function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(arr) ? arr.slice(-MAX_HISTORY) : [];
  } catch (e) {
    // История чата не прочиталась: начнём с пустой. Без записи это выглядит как
    // «переписка пропала сама».
    noteSwallowed('ai-chat', 'история не прочитана', e);
    return [];
  }
}

export function saveHistory(history: ChatMessage[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch (e) {
    // Чаще всего это переполнение localStorage: история молча перестаёт
    // сохраняться между заходами.
    noteSwallowed('ai-chat', 'история не записана', e);
  }
}

export function clearHistory(): void {
  try { localStorage.removeItem(LS_KEY); }
  catch (e) { noteSwallowed('ai-chat', 'история не очищена', e); }
}

export function newMessage(role: ChatRole, content: string): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role, content, ts: Date.now(),
  };
}

export type ChatResponse = {
  ok: boolean;
  reply?: string;
  contextAt?: number;
  usage?: any;
  error?: string;
};

/**
 * Собираем контекст бизнеса прямо из localStorage. На фронте уже лежат
 * все цифры дашборда — Ozon (live-ozon-state:v1), WB (live-wb-state:v1)
 * и каталог (live-ozon-bundle:v1). Отправляем их в чат — Claude получит
 * актуальные значения без зависимости от Vercel KV.
 */
type LocalContext = {
  ozon?: { revenue: number; orders: number; avgCheck: number; products: number; period: string };
  wb?: { revenue: number; orders: number; avgCheck: number; products: number };
  topProducts?: Array<{ name: string; sku: string | number; revenue?: number; orders?: number; price?: number }>;
  ads?: {
    period: string;
    расход: number; выручка: number; roas: number | null; ДРР_процент: number | null;
    кампаний: number; активных: number;
    топ_по_расходу: Array<{ название: string; расход: number; заказов: number; выручка: number; ДРР_процент: number | null; статус?: string }>;
  };
  // ROI/маржа/себестоимость из листа «Маржа» (модуль ROI). Пишется useProcurement.
  margins?: {
    count: number;
    items: Array<{
      sku: string; name: string;
      roiOzon: number | null; roiWb: number | null;
      marginOzon: number | null; marginWb: number | null;
      cost: number | null;
      priceOzon: number | null; priceWb: number | null;
      profitWeekOzon: number | null; profitWeekWb: number | null;
      sales7Ozon: number; sales7Wb: number;
    }>;
  };
};

function readLS<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

export function collectContext(): LocalContext {
  const ctx: LocalContext = {};
  // Ozon — выбираем самый «свежий» период из тех что есть
  const ozonAll = readLS<Record<string, { state: any; ts: number }>>('live-ozon-state:v1');
  if (ozonAll) {
    const periods = ['day', 'week', 'month'] as const;
    for (const p of periods) {
      const s = ozonAll[p]?.state;
      if (s && s.revenue > 0) {
        ctx.ozon = {
          revenue: s.revenue, orders: s.orders, avgCheck: s.avgCheck,
          products: s.totalProducts, period: p,
        };
        break;
      }
    }
  }
  // WB — то же
  const wbAll = readLS<Record<string, { state: any; ts: number }>>('live-wb-state:v1');
  if (wbAll) {
    const periods = ['day', 'week', 'month'] as const;
    for (const p of periods) {
      const s = wbAll[p]?.state;
      if (s && s.revenue > 0) {
        ctx.wb = {
          revenue: s.revenue, orders: s.orders, avgCheck: s.avgCheck,
          products: s.totalProducts,
        };
        break;
      }
    }
  }
  // Топ-товары по выручке из Ozon bundle. OzonTopSku имеет {sku,name,orders,revenue},
  // но Ozon Analytics временами возвращает пустой name. В этом случае подмешиваем
  // имя из каталога: skuToPid (sku→product_id) + products[].name.
  const ozonBundle = readLS<any>('live-ozon-bundle:v1');
  if (ozonBundle?.topByWeek?.length) {
    const products = ozonBundle.products || [];
    const productById = new Map<number, any>();
    for (const p of products) productById.set(p.id, p);
    // skuToPid в localStorage хранится как массив entries (см. useLiveOzonCache.saveToLS)
    const skuToPid = new Map<string, number>(ozonBundle.skuToPidEntries || []);

    ctx.topProducts = (ozonBundle.topByWeek as any[]).slice(0, 10).map((t: any) => {
      let name = t.name;
      let price: number | undefined;
      if (!name || name === t.sku) {
        const pid = skuToPid.get(String(t.sku));
        if (pid) {
          const prod = productById.get(pid);
          if (prod?.name) name = prod.name;
          if (prod?.price) price = parseFloat(prod.price);
        }
      }
      return {
        name: name || `товар ${t.sku}`,
        sku: t.sku,
        revenue: t.revenue,
        orders: t.orders,
        price,
      };
    });
  }

  // Реклама Ozon — из того же кэша, что использует страница «Реклама» (окно 7 дней).
  // Без этого копилот не мог отвечать на вопросы про кампании (жалоба 03.07).
  try {
    const cmp = readOzonPerfCache<{ list: any[] }>('/api/client/campaign');
    const from = localDateStr(7), to = localDateStr(1);
    const dailyC = readOzonPerfCache<{ rows: any[] }>(`/api/client/statistics/daily/json?dateFrom=${from}&dateTo=${to}`);
    const rows = dailyC?.data?.rows ?? [];
    if (rows.length) {
      const cmpMeta = new Map<string, any>();
      for (const c of (cmp?.data?.list ?? [])) cmpMeta.set(String(c.id), c);
      const byId = new Map<string, { id: string; title?: string; sum: number; orders: number; ordersMoney: number }>();
      let totSum = 0, totMoney = 0;
      for (const r of rows) {
        const id = String(r.id);
        const cur = byId.get(id) || { id, title: r.title, sum: 0, orders: 0, ordersMoney: 0 };
        cur.sum += parseRu(r.moneySpent);
        cur.orders += parseRu(r.orders);
        cur.ordersMoney += parseRu(r.ordersMoney);
        byId.set(id, cur);
        totSum += parseRu(r.moneySpent);
        totMoney += parseRu(r.ordersMoney);
      }
      const list = [...byId.values()].sort((a, b) => b.sum - a.sum);
      const campaignsAll = cmp?.data?.list ?? [];
      ctx.ads = {
        period: `7 дней (${from}–${to})`,
        расход: Math.round(totSum),
        выручка: Math.round(totMoney),
        roas: totSum > 0 ? +(totMoney / totSum).toFixed(2) : null,
        ДРР_процент: totMoney > 0 ? +((totSum / totMoney) * 100).toFixed(1) : null,
        кампаний: campaignsAll.length,
        активных: campaignsAll.filter((c: any) => c.state === 'CAMPAIGN_STATE_RUNNING').length,
        топ_по_расходу: list.slice(0, 12).map((c) => ({
          название: c.title || cmpMeta.get(c.id)?.title || `Кампания ${c.id}`,
          расход: Math.round(c.sum),
          заказов: c.orders,
          выручка: Math.round(c.ordersMoney),
          ДРР_процент: c.sum > 0 && c.ordersMoney > 0 ? +((c.sum / c.ordersMoney) * 100).toFixed(1) : null,
          статус: cmpMeta.get(c.id)?.state === 'CAMPAIGN_STATE_RUNNING' ? 'активна'
                : cmpMeta.get(c.id)?.state ? 'выключена' : undefined,
        })),
      };
    }
  } catch (e) {
    // Реклама в контексте опциональна, но если её нет, копилот отвечает «нет
    // данных по рекламе», и надо понимать, это правда пусто или блок упал.
    noteSwallowed('ai-chat', 'контекст по рекламе не собран', e);
  }

  // Маржа / ROI / себестоимость — из снимка листа «Маржа» (пишет useProcurement).
  // Даёт копилоту ответить на вопросы про рентабельность конкретных SKU.
  try {
    const mc = readLS<{ ts: number; count: number; items: any[] }>('procurement-context:v1');
    if (mc?.items?.length) {
      ctx.margins = { count: mc.count ?? mc.items.length, items: mc.items };
    }
  } catch (e) {
    // То же и с маржой: без неё копилот не ответит про рентабельность.
    noteSwallowed('ai-chat', 'контекст по марже не собран', e);
  }

  return ctx;
}

export async function sendChat(messages: ChatMessage[], currentPage?: string): Promise<ChatResponse> {
  const localContext = collectContext();
  const r = await fetch('/api/ai/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      currentPage,
      localContext,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 300);
    // Тело ошибки бывает не JSON (HTML от nginx, пустая строка). Тогда detail
    // остаётся сырым текстом, и ошибка всё равно уходит наверх со всем, что было:
    // писать в журнал тут нечего, наверх уже проброшено.
    try { const j = JSON.parse(text); detail = j.detail || j.error || detail; } catch {}
    return { ok: false, error: `${r.status}: ${detail}` };
  }
  return JSON.parse(text) as ChatResponse;
}
