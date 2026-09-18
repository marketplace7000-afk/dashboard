import { useEffect, useState } from 'react';

// Транзит на склады МП (в пути + на приёмке) — карта SKU(UPPER) → кол-во.
// Считается на сервере (часовой кэш), фронт лишь читает готовое.
// Ozon: /api/ozon-transit (ключ offer_id). WB: /api/wb-transit (ключ vendorCode).
export type MpTransit = {
  items: Record<string, number>;
  totalUnits: number;
  fetchedAt: number;
  ordersCount?: number;
  suppliesCount?: number;
  byState?: Record<string, number>;
  byStatus?: Record<string, number>;
};

function useMpTransit(endpoint: string) {
  const [data, setData] = useState<MpTransit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(endpoint, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as MpTransit;
        if (alive) setData(j);
      } catch (e: any) {
        if (alive) setError(e?.message || 'Ошибка');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [endpoint]);

  const transitFor = (sku: string): number =>
    data?.items[String(sku || '').trim().toUpperCase()] ?? 0;

  return { data, loading, error, transitFor };
}

export type OzonTransit = MpTransit;
export const useOzonTransit = () => useMpTransit('/api/ozon-transit');
export const useWbTransit = () => useMpTransit('/api/wb-transit');
