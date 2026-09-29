/**
 * Кому бот отвечает.
 *
 * 01.09 бота добавили в рабочий чат клиента, и он отвечал НА КАЖДОЕ сообщение —
 * разговаривать в группе стало невозможно, бота пришлось срочно выключать.
 * Проверки не было вовсе: любой текст уходил в обработчик команд.
 *
 * Здесь зафиксировано правило: в личке отвечаем на всё, в группе только на
 * явное обращение. Проверка нужна потому, что цена ошибки — не сломанный
 * расчёт, а испорченный рабочий чат живых людей.
 *
 * Запуск: npm run check
 */
process.env.TELEGRAM_BOT_USERNAME = 'Podsort_FF_bot';

import { messageForBot } from '../api/_lib/telegramBot';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const group = (text: string, extra: Record<string, unknown> = {}) =>
  ({ chat: { id: -1, type: 'supergroup' }, text, ...extra });
const priv = (text: string) => ({ chat: { id: 1, type: 'private' }, text });

console.log('В группе — только явное обращение');
check('обычная фраза игнорируется', messageForBot(group('давай созвон в три')), null);
check('фраза с упоминанием другого бота игнорируется', messageForBot(group('@other_bot цены')), null);
check('команда со слэша принимается', messageForBot(group('/цены')), '/цены');
check('команда с суффиксом бота принимается', messageForBot(group('/цены@Podsort_FF_bot')), '/цены@Podsort_FF_bot');
check('упоминание принимается, упоминание вырезается', messageForBot(group('@Podsort_FF_bot цены')), 'цены');
check('упоминание без текста даёт справку', messageForBot(group('@Podsort_FF_bot')), '/help');
check('ответ на сообщение бота принимается',
  messageForBot(group('а по Ozon?', { reply_to_message: { from: { is_bot: true, username: 'Podsort_FF_bot' } } })), 'а по Ozon?');
check('ответ на сообщение человека игнорируется',
  messageForBot(group('ага', { reply_to_message: { from: { is_bot: false, username: 'dmitry' } } })), null);

console.log('\nВ личке — как раньше');
check('обычная фраза принимается', messageForBot(priv('цены')), 'цены');
check('пустое сообщение игнорируется', messageForBot(priv('   ')), null);

console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
