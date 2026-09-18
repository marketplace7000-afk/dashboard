// Фоновая предзагрузка всех данных платформы при входе (просьба клиента 20.07):
// «зашёл один раз — всё прогрузилось, между вкладками хожу без ожидания».
//
// Все данные и так идут из серверного кэша (cron греет WB/Ozon), но каждый
// модуль начинал тянуть их только при открытии своей вкладки. Здесь мы просто
// дёргаем те же самые лоадеры заранее, со ступенчатой задержкой, чтобы не
// выстрелить всеми запросами одновременно. Повторные вызовы безопасны:
// каждый лоадер сам проверяет свежесть кэша и не дублирует запросы.

import { prefetchProcurement } from './useProcurement';
import { prefetchOzonBundle } from './useLiveOzonCache';
import { prefetchWbBundle } from './useLiveWbCache';
import { prefetchLiveWb } from './useLiveWb';

let started = false;

export function prefetchAll() {
  if (started) return; // один раз за сессию — дальше кэши сами живут
  started = true;
  // Закупочная таблица — база для половины модулей (маржа/ROI/себестоимость).
  prefetchProcurement();
  // Ozon-бандл (цены, остатки, аналитика) — обычно самый быстрый.
  setTimeout(prefetchOzonBundle, 300);
  // WB-бандл (цены + карточки) — вкладка «Цены».
  setTimeout(prefetchWbBundle, 800);
  // KPI дашборда WB по периодам (день — лендинг, неделя/месяц — переключатели).
  setTimeout(() => prefetchLiveWb('day'), 1300);
  setTimeout(() => prefetchLiveWb('week'), 2500);
  setTimeout(() => prefetchLiveWb('month'), 4000);
}
