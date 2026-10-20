/**
 * Список отправлений Ozon FBS — v4/posting/fbs/list.
 *
 * 19.10.2026 Ozon перевёл FBS на v4: v3/posting/fbs/list с этого дня отвечает
 * только 429 «rate limit per second» (даже на одиночный запрос), а
 * v3/posting/fbs/unfulfilled/list — 400 «obsolete method cannot be used».
 * Отличия v4 (проверено 20.10 на живом кабинете):
 *   • limit ≤ 100 (на 1000 — 400 «value must be inside range (0, 100]»);
 *   • курсорная пагинация: { postings, has_next, cursor } на ВЕРХНЕМ уровне,
 *     следующая страница — тот же запрос с `cursor` вместо `offset`;
 *   • `dir: 'DESC'` игнорируется — список всегда от старых к новым;
 *   • деньги — объекты { amount, currency }: products[].price и
 *     financial_data.products[].customer_price. Ниже приводим их к строке,
 *     как было в v3, чтобы разбор в rnp / ozonBuyerPrices не поменялся.
 */
export type OzPost = (path: string, body: Record<string, unknown>) => Promise<any>;

const PAGE = 100;

/** Сумма из { amount } → строка, как в v3. */
function flatMoney(v: any): any {
  return v && typeof v === 'object' && 'amount' in v ? String(v.amount) : v;
}

function normalize(p: any): any {
  for (const pr of (p?.products ?? [])) pr.price = flatMoney(pr.price);
  for (const fp of (p?.financial_data?.products ?? [])) fp.customer_price = flatMoney(fp.customer_price);
  return p;
}

/**
 * Все отправления FBS за окно `body.filter` (since/to). `body` — как у v3 без
 * limit/offset/dir. Бросает исключение, если Ozon ответил ошибкой — вызывающий
 * решает, писать ли частичный результат.
 */
export async function listOzonFbsPostings(
  post: OzPost,
  body: Record<string, unknown>,
  opts: { maxPages?: number; pauseMs?: number } = {},
): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 300); page++) {
    const j = await post('v4/posting/fbs/list', { ...body, dir: 'ASC', limit: PAGE, ...(cursor ? { cursor } : {}) });
    const batch: any[] = j?.postings ?? j?.result?.postings ?? [];
    for (const p of batch) out.push(normalize(p));
    cursor = j?.cursor;
    if (!j?.has_next || !cursor || batch.length === 0) break;
    await new Promise(r => setTimeout(r, opts.pauseMs ?? 300)); // лимит Ozon «в секунду»
  }
  return out;
}
