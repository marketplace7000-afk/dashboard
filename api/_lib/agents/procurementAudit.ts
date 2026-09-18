/**
 * Агент 8 — «Аудит закупок».
 *
 * Сам смотрит таблицу закупщика и пишет в Telegram, что пора пополнять, — не
 * дожидаясь, пока кто-то откроет раздел «Прогноз закупок».
 *
 * Логика (упрощённая версия фронтового applyLogic, без пер-SKU настроек):
 *   покрытие_дней = (остатки МП + склад + транзит) / средние_продажи_в_день
 * Если покрытия не хватает на цикл поставки (срок + упаковка), товар закончится
 * раньше, чем приедет новая партия → надо заказывать. Товары без продаж
 * пропускаем: у них покрытие бесконечное и дозаказ не нужен.
 */
import { fetchStockSnapshot } from '../sheets';
import { Agent, AgentMessage, mskDay } from './types';

// Цикл поставки из Китая по умолчанию: 52 дн производство/доставка + 14 дн упаковка
// (те же дефолты, что в UI закупок). Порог переопределяется env.
const CYCLE_DAYS = Number(process.env.AGENT_PROCUREMENT_CYCLE_DAYS) || 66;

async function run(): Promise<AgentMessage[]> {
  const rows = await fetchStockSnapshot();
  if (!rows.length) return [];

  const urgent: { sku: string; days: number; stock: number }[] = [];
  for (const r of rows) {
    if (r.daily <= 0) continue;                      // не продаётся — дозаказ не нужен
    if (/-DUBL$/i.test(r.sku)) continue;             // служебные дубли строк в таблице
    const stock = r.stockOzon + r.stockWB + r.warehouseStock + r.transit;
    const days = stock / r.daily;
    if (days < CYCLE_DAYS) urgent.push({ sku: r.sku, days: Math.round(days), stock });
  }
  if (!urgent.length) return [];

  urgent.sort((a, b) => a.days - b.days);            // самые горящие сверху
  // Перечисляем все позиции: обрезка списка скрывала часть товаров, а именно
  // ради полного списка агент и нужен. Длинное сообщение бот разобьёт на части.
  const lines = urgent.map(u => `• <b>${u.sku}</b> — хватит на ${u.days} дн (остаток ${u.stock} шт)`);

  return [{
    key: `agent8:procurement:${mskDay()}`,
    text: `📦 <b>Аудит закупок: пора пополнять ${urgent.length} SKU</b>\n` +
          `<i>запаса не хватает на цикл поставки (${CYCLE_DAYS} дн)</i>\n\n` +
          lines.join('\n') +
          `\n\nПодробности и рекомендуемые объёмы — в разделе «Прогноз закупок».`,
  }];
}

export const procurementAuditAgent: Agent = {
  id: 'procurement-audit',
  name: 'Агент 8 · Аудит закупок',
  role: 'Сам проверяет остатки по таблице и пишет, что пора пополнять',
  schedule: 'daily',
  run,
};
