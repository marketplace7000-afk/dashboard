// Подсказка по рекламе в строке товара (просьба клиента 16.09.2026). Только совет,
// никаких действий в кабинете. Вход — то, что уже посчитано для строки: ДРР (рабочий, 7д, 30д),
// заказы за 7 дн, маржа после рекламы, ROI, есть ли товар в наличии.

export type AdsAdvice = { text: string; tone: 'good' | 'warn' | 'bad' | 'muted'; hint: string };

export function adsAdvice(a: {
  drr: number | null | undefined;
  drr7: number | null;
  drr30: number | null;
  orders7: number;
  marginPct: number | null;
  roi: number | null;
  inStock: boolean;
}): AdsAdvice | null {
  const { drr7, drr30, orders7, marginPct, roi, inStock } = a;
  const drr = a.drr ?? null;
  const hasAds = (drr7 ?? 0) > 0 || (drr30 ?? 0) > 0;
  if (!hasAds) {
    if (marginPct != null && marginPct >= 20 && inStock && orders7 >= 3) {
      return { text: 'реклама: можно тестировать', tone: 'muted', hint: `Рекламы нет, маржа ${marginPct}% и есть спрос (${orders7} зак. за 7 дн) — есть запас, чтобы попробовать продвижение` };
    }
    return null;
  }
  if (!inStock) return { text: 'реклама: выключить — нет остатка', tone: 'bad', hint: 'Реклама крутится, а товара нет в наличии — бюджет уходит впустую' };
  if (marginPct != null && marginPct < 0) return { text: 'реклама: убыточна — снизить/отключить', tone: 'bad', hint: `Маржа с учётом ДРР ${drr ?? '—'}% ушла в минус (${marginPct}%)` };
  if (drr7 != null && drr30 != null && drr30 > 0 && drr7 > drr30 * 1.5 && drr7 - drr30 >= 3) {
    return { text: `реклама: ДРР вырос ${drr30}% → ${drr7}%`, tone: 'warn', hint: 'За неделю доля рекламных расходов выросла в полтора раза против месяца — проверить ставки и кампании' };
  }
  if (marginPct != null && marginPct < 10) return { text: 'реклама: маржа тонкая — снизить ставку', tone: 'warn', hint: `Маржа после рекламы ${marginPct}% — реклама съедает почти всё` };
  if (marginPct != null && marginPct >= 25 && roi != null && roi >= 60 && (drr ?? 0) <= 10) {
    return { text: 'реклама: можно усилить', tone: 'good', hint: `ДРР ${drr}%, маржа ${marginPct}%, ROI ${roi}% — запас есть, можно поднять бюджет` };
  }
  return { text: 'реклама: в норме', tone: 'muted', hint: `ДРР ${drr ?? '—'}% · маржа ${marginPct ?? '—'}%` };
}
