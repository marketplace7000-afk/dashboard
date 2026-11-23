/**
 * Выплаты Ozon → платёжный календарь (23.11.2026, просьба владельца: «чтобы календарь сам видел выплаты Ozon, обязательно утром»).
 *
 * Источник — POST /v1/finance/cash-flow-statement/list (согласовано с диспетчером API 23.11: 08:06, 12:06, 18:06 МСК,
 * повтор 08:36 только если утро не прошло; правило шлюза oz:cashflow — не чаще раза в 5 с). Один запрос за 35 дней.
 * Ответ — недели продаж «пн–вс» (на стыке месяцев неделя делится на две части):
 *   • invoice_transfer — сумма к перечислению за неделю, займ Ozon уже вычтен;
 *   • payments[].payment — сколько реально выплачено в эту неделю (со знаком минус).
 * Точной даты выплаты Ozon не отдаёт: продажи недели он перечисляет в среду через две недели после неё
 * (понедельник недели + 23 дня; совпало на пяти выплатах подряд).
 *
 * Что делаем с календарём (строки cat «Выплата Ozon», ключ OZ#<дата выплаты>):
 *   • по каждой ЗАКРЫТОЙ неделе (воскресенье уже прошло) — строка на дату выплаты с суммой invoice_transfer:
 *     есть строка с ключом — правим сумму и подпись; есть строка Ozon без ключа или с прогнозом в пределах ±6 дней — берём её;
 *     нет — добавляем «Подтверждено»;
 *   • выплата пришла (есть payments в неделе даты выплаты) — подсказка в комментарии «отметьте Исполнено».
 * «Исполнено» и факт не трогаем никогда — их ставит человек. Строки, где уже стоит «Исполнено» или факт, не меняем.
 * Сбой Ozon — календарь не трогаем, пишем в журнал и в fin_setting 'ozon_payouts_state' (его читает сторож).
 */
import { dayNum, dayStr, mskToday, type FinOp } from '../../shared/finance';
import { allOps, finDb, saveOp } from './finance';
import { fetchWithRetry } from './fetchRetry';

const WHO = 'Ozon API';
const CAT = 'Выплата Ozon';

export type OzWeek = { begin: string; end: string; invoice: number; paid: number };
export type OzPayout = { date: string; begin: string; end: string; amount: number };

/** Понедельник недели, в которую попадает дата. */
const mondayOf = (d: string) => { const n = dayNum(d); const wd = (new Date(n * 86_400_000).getUTCDay() + 6) % 7; return n - wd; };
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;

/** Ответ Ozon → недели (части одной недели не склеиваем здесь — склеиваем по дате выплаты). */
export function parseWeeks(json: any): OzWeek[] {
  const det: any[] = json?.result?.details ?? [];
  return det.map(d => ({
    begin: String(d?.period?.begin ?? '').slice(0, 10), end: String(d?.period?.end ?? '').slice(0, 10),
    invoice: Number(d?.invoice_transfer) || 0,
    paid: -((d?.payments ?? []) as any[]).reduce((s, p) => s + (Number(p?.payment) || 0), 0),
  })).filter(w => /^\d{4}-\d{2}-\d{2}$/.test(w.begin) && /^\d{4}-\d{2}-\d{2}$/.test(w.end));
}
/** Закрытые недели → выплаты по датам (среда: понедельник недели + 23 дня). */
export function payoutsFrom(weeks: OzWeek[], today: string): OzPayout[] {
  const by = new Map<string, OzPayout>();
  for (const w of weeks) {
    const sunday = mondayOf(w.begin) + 6;
    if (sunday >= dayNum(today)) continue;   // неделя ещё идёт — сумма не итоговая
    const date = dayStr(mondayOf(w.begin) + 23);
    const p = by.get(date) ?? { date, begin: w.begin, end: w.end, amount: 0 };
    p.amount += w.invoice; if (w.begin < p.begin) p.begin = w.begin; if (w.end > p.end) p.end = w.end;
    by.set(date, p);
  }
  return [...by.values()].filter(p => p.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
}
/** Сколько Ozon выплатил в неделю, куда попадает дата. */
const paidInWeekOf = (weeks: OzWeek[], date: string) =>
  weeks.filter(w => w.begin <= date && date <= w.end).reduce((s, w) => s + w.paid, 0);

export type OzState = { at: string; ok: boolean; error?: string; added: number; updated: number; hinted: number };
function saveState(s: OzState) {
  finDb().prepare('INSERT INTO fin_setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('ozon_payouts_state', JSON.stringify(s));
}
export function ozState(): OzState | null {
  try { const r = finDb().prepare("SELECT v FROM fin_setting WHERE k = 'ozon_payouts_state'").get() as { v: string } | undefined; return r ? JSON.parse(r.v) : null; } catch { return null; }
}

/** Свести выплаты с календарём. Чистая часть — отдельно, чтобы проверять без Ozon. */
export function applyPayouts(weeks: OzWeek[], today: string, now = new Date()): Omit<OzState, 'at' | 'ok'> {
  const res = { added: 0, updated: 0, hinted: 0 };
  const pays = payoutsFrom(weeks, today).filter(p => p.date >= dayStr(dayNum(today) - 7));
  const ops = allOps().filter(o => o.type === 'in' && o.cat === CAT);
  const used = new Set<number>();
  const stamp = `${ddmm(today)} ${String(new Date(now.getTime() + 3 * 3_600_000).getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  for (const p of pays) {
    const key = `OZ#${p.date}`;
    let row: FinOp | undefined = ops.find(o => o.key === key);
    if (!row) row = ops.filter(o => !used.has(o.id) && o.status !== 'Исполнено' && o.status !== 'Отменено' && o.fact === null
      && (!o.key || (o.key.startsWith('OZ#') && !pays.some(q => `OZ#${q.date}` === o.key)))
      && Math.abs(dayNum(o.date) - dayNum(p.date)) <= 6)
      .sort((a, b) => Math.abs(dayNum(a.date) - dayNum(p.date)) - Math.abs(dayNum(b.date) - dayNum(p.date)))[0];
    const descr = `Ozon Avto Vibe · реализация за ${ddmm(p.begin)}–${ddmm(p.end)}`;
    const paid = p.date <= today ? paidInWeekOf(weeks, p.date) : 0;
    const base = `сумма из Ozon API (к перечислению, займ Ozon уже вычтен), сверено ${stamp}; дата — среда по графику Ozon`;
    const hint = paid > 0 ? ` · по Ozon в эту неделю выплачено ${rub(paid)} — проверьте счёт и отметьте «Исполнено»` : '';
    if (!row) {
      const acc = ops.filter(o => o.account).sort((a, b) => b.date.localeCompare(a.date))[0]?.account ?? '';
      saveOp({ date: p.date, type: 'in', cat: CAT, descr, plan: Math.round(p.amount), fact: null, status: 'Подтверждено', account: acc, source: WHO, resp: '', comment: base + hint, key }, WHO);
      res.added++; if (hint) res.hinted++;
      continue;
    }
    used.add(row.id);
    if (row.status === 'Исполнено' || row.fact !== null) continue;   // человек уже отметил — не трогаем
    const plan = Math.round(p.amount);   // до рубля, как в кабинете и остальном календаре: копейки не повод править строку
    const changed = row.plan !== plan || row.date !== p.date || row.descr !== descr || row.key !== key;
    const comment = (changed || hint) ? base + hint : row.comment;
    if (!changed && (!hint || row.comment.includes(hint.trim()))) continue;   // подсказка уже стоит — не переписываем ради новой отметки времени
    const prev = row.plan !== plan ? ` (было ${rub(row.plan)})` : '';
    saveOp({ ...row, date: p.date, plan, descr, comment: comment + prev, status: row.status === 'Прогноз' || row.status === 'План' ? 'Подтверждено' : row.status }, WHO);
    if (row.key !== key) finDb().prepare('UPDATE fin_op SET key = ? WHERE id = ?').run(key, row.id);   // ключ из интерфейса не меняется — ставим сами
    if (changed) res.updated++; if (hint) res.hinted++;
  }
  return res;
}

let running = false;
/** Запрос к Ozon и сведение. Ошибка Ozon — календарь не трогаем. */
export async function syncOzonPayouts(why = 'по расписанию', now = Date.now()): Promise<OzState | null> {
  if (!process.env.OZON_CLIENT_ID || !process.env.OZON_API_KEY) return null;
  if (running) return null; running = true;
  const today = mskToday();
  const st: OzState = { at: new Date(now).toISOString(), ok: true, added: 0, updated: 0, hinted: 0 };
  try {
    const from = dayStr(dayNum(today) - 35);
    const r = await fetchWithRetry('https://api-seller.ozon.ru/v1/finance/cash-flow-statement/list', {
      method: 'POST',
      headers: { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: { from: `${from}T00:00:00.000Z`, to: `${today}T23:59:59.000Z` }, with_details: true, page: 1, page_size: 50 }),
    }, { maxRetries: 3, backoff429Ms: 5_000, priority: 1, timeoutMs: 60_000 });
    if (!r.ok) throw new Error(`Ozon ответил ${r.status}`);
    const weeks = parseWeeks(await r.json());
    if (!weeks.length) throw new Error('Ozon вернул пустой отчёт — календарь не трогаю');
    Object.assign(st, applyPayouts(weeks, today, new Date(now)));
    if (st.added || st.updated) console.warn(`[finance-ozon] выплаты Ozon (${why}): добавлено ${st.added}, исправлено ${st.updated}, подсказок «пришло» ${st.hinted}`);
  } catch (e) {
    st.ok = false; st.error = (e as Error).message;
    console.warn('[finance-ozon] выплаты Ozon не прочитаны:', st.error);
  } finally {
    running = false;
    try { saveState(st); } catch (e) { console.warn('[finance-ozon] состояние не записано:', (e as Error).message); }
  }
  return st;
}
