import { ChartBarIcon, WarningIcon, CurrencyRubIcon, CheckIcon, PencilSimpleIcon, XIcon } from '@phosphor-icons/react';
import { Stub } from '../components/Stub';
import { TelegramLiveStatus } from '../components/TelegramLiveStatus';

const TgIcon = ({ Icon, color }: { Icon: any; color?: string }) => (
  <Icon size={16} weight="fill" style={{ verticalAlign: '-3px', marginRight: 6, color: color ?? 'var(--accent)' }} />
);

export function Telegram() {
  return (
    <div className="grid" style={{ gap: 20 }}>
      <TelegramLiveStatus />

      <div className="grid grid-2" style={{ gap: 24, alignItems: 'flex-start' }}>
      <div className="grid" style={{ gap: 16 }}>
        <Stub title="Скелет интеграции готов · ждём токен @BotFather">
          Бот доставляет: алерты о негативе ≤3 звезды, одобрение черновиков ответов,
          дневной/недельный отчёты, рекомендации по ценам с кнопкой «Применить».
        </Stub>

        <div className="card">
          <h2>Сценарии бота</h2>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9, color: 'var(--muted)' }}>
            <li><b style={{ color: 'var(--text)' }}>Алерт ≤3 звезды</b> — мгновенно, в течение 5 мин после появления.</li>
            <li><b style={{ color: 'var(--text)' }}>Одобрение ответа</b> — кнопка «✓ Опубликовать» / «✎ Изменить» / «✕ Отклонить».</li>
            <li><b style={{ color: 'var(--text)' }}>Дневной отчёт</b> — каждый день в 09:00.</li>
            <li><b style={{ color: 'var(--text)' }}>Недельный отчёт</b> — понедельник 09:00.</li>
          </ul>
        </div>

        <div className="card">
          <h2>Команды бота</h2>
          <table>
            <thead>
              <tr><th>Команда</th><th>Что делает</th></tr>
            </thead>
            <tbody>
              <tr><td><code>/status</code></td><td>Сводка: сколько отзывов в очереди, активны ли воркеры, бюджет LLM</td></tr>
              <tr><td><code>/today</code></td><td>Текущая выручка, заказы, средний чек за сегодня</td></tr>
              <tr><td><code>/week</code></td><td>Свод за 7 дней с динамикой</td></tr>
              <tr><td><code>/queue</code></td><td>Список отзывов, ждущих одобрения, с inline-кнопками</td></tr>
              <tr><td><code>/pause_pricing</code></td><td>Поставить репрайсер на паузу до ручного <code>/resume_pricing</code></td></tr>
              <tr><td><code>/resume_pricing</code></td><td>Возобновить автоприменение цен</td></tr>
              <tr><td><code>/sku 218430551</code></td><td>Карточка артикула: цена, остаток, конкуренты</td></tr>
              <tr><td><code>/budget</code></td><td>Расход на LLM сегодня и остаток дневного лимита</td></tr>
              <tr><td><code>/help</code></td><td>Список команд</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="tg-frame">
        <div className="tg-header">
          <div className="tg-avatar">AV</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Avto Vibe · ИП Алешко</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>bot · в сети</div>
          </div>
        </div>
        <div className="tg-body">
          <div className="tg-msg">
            <b><TgIcon Icon={ChartBarIcon} />Дневной отчёт · 06 мая</b>{'\n'}
            Выручка: 184 320 ₽{'\n'}
            Заказов: 47 (+5 к прошлой неделе){'\n'}
            Средний чек: 3 922 ₽{'\n'}
            Возвраты: 3{'\n\n'}
            Топ-1: CarPlay-адаптер 7" — 14 шт / 83 860 ₽
            <div className="meta">09:00</div>
          </div>

          <div className="tg-msg" style={{ background: 'rgba(220,38,38,.06)' }}>
            <b><TgIcon Icon={WarningIcon} color="var(--bad)" />Негативный отзыв · 2 звезды</b>{'\n'}
            Товар: Android-магнитола 9" 2K CarPlay{'\n'}
            «Пришла с битым тачем, CarPlay отваливается…»{'\n\n'}
            <i>Черновик ответа готов:</i>{'\n'}
            «Сергей, оформим замену по гарантии без возврата товара. По CarPlay —
            пришлите версию прошивки, в 2.4.1 эту проблему мы починили…»
            <div className="tg-buttons">
              <button className="tg-btn"><CheckIcon size={13} weight="bold" /> Опубликовать</button>
              <button className="tg-btn"><PencilSimpleIcon size={13} weight="bold" /> Изменить</button>
              <button className="tg-btn"><XIcon size={13} weight="bold" /> Отклонить</button>
            </div>
            <div className="meta">12:48</div>
          </div>

          <div className="tg-msg">
            <b><TgIcon Icon={CurrencyRubIcon} color="var(--good)" />Цена изменена</b>{'\n'}
            218430551 · CarPlay-адаптер 7"{'\n'}
            6 190 → <b>5 990 ₽</b>{'\n'}
            Причина: конкурент снизил до 5 790 ₽
            <div className="meta">14:02</div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
