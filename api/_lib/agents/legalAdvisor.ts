/**
 * Агент 9 — «Мини-юрист».
 *
 * Отвечает на вопросы по налогам/законам/договорам для ИП на маркетплейсах.
 * Вызывается по команде из Telegram: /юрист <вопрос>.
 *
 * База знаний: текстовые файлы в api/_data/legal/ (клиент кладёт туда выдержки
 * НК, договоры оферты МП, свои регламенты). Файлы подмешиваются в контекст —
 * так ответ опирается на реальные документы клиента, а не только на общие знания
 * модели. Если папки нет, агент всё равно работает (общими знаниями) и честно
 * помечает это в ответе.
 *
 * ⚠️ Дисклеймер добавляем всегда: это справка, а не юридическое заключение.
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { callAnthropic } from '../anthropic';
import { thesesAsContext } from './knowledgeBase';
import { Agent, AgentMessage } from './types';

const LEGAL_DIR = join(process.cwd(), 'api', '_data', 'legal');
const MAX_DOC_CHARS = 60_000;   // ~15k токенов контекста на документы

/** Читает базу знаний из api/_data/legal (.txt/.md). Пусто, если папки нет. */
async function loadKnowledge(): Promise<{ text: string; files: string[] }> {
  try {
    const names = (await readdir(LEGAL_DIR)).filter(f => /\.(txt|md)$/i.test(f));
    if (!names.length) return { text: '', files: [] };
    const parts: string[] = [];
    const used: string[] = [];
    let total = 0;
    for (const name of names) {
      if (total >= MAX_DOC_CHARS) break;
      const body = await readFile(join(LEGAL_DIR, name), 'utf-8');
      const slice = body.slice(0, MAX_DOC_CHARS - total);
      parts.push(`### Документ: ${name}\n${slice}`);
      used.push(name);
      total += slice.length;
    }
    return { text: parts.join('\n\n'), files: used };
  } catch {
    return { text: '', files: [] };   // папки нет — работаем без базы
  }
}

const SYSTEM = [
  'Ты — юридический и налоговый ассистент для ИП, торгующего на Wildberries и Ozon (РФ).',
  'Отвечай кратко, по-русски, структурно: суть → что делать → на что опереться.',
  'Если в контексте есть документы клиента — опирайся В ПЕРВУЮ ОЧЕРЕДЬ на них и ссылайся на имя файла.',
  'Если вопрос требует индивидуальной оценки или данных, которых нет — прямо скажи, чего не хватает.',
  'НИКОГДА не выдумывай номера статей, сумм и сроков. Не уверен — так и напиши.',
  'В конце всегда добавляй строку: «⚖️ Это справка, а не юридическое заключение — сверьтесь с бухгалтером/юристом.»',
].join('\n');

/** Ответ на конкретный вопрос (команда /юрист). */
export async function askLegal(question: string): Promise<string> {
  const kb = await loadKnowledge();
  const parts: string[] = [];

  parts.push(kb.text
    ? `Документы клиента (основной источник):\n\n${kb.text}`
    : 'База документов клиента пуста — отвечай общими знаниями и честно помечай, что документы не подключены.');

  // Тезисы из «Базы знаний» — свежие изменения тарифов, комиссий, правил и новостей
  // площадок. Так юрист отвечает с учётом того, что реально поменялось у WB/Ozon,
  // а не только по статичным документам (объединение агентов 6, 7, 9 и 17).
  const theses = thesesAsContext(120);
  if (theses) parts.push(`Свежие изменения на площадках (из базы знаний):\n${theses}`);

  const { text } = await callAnthropic({
    system: SYSTEM,
    messages: [{ role: 'user', content: `${parts.join('\n\n')}\n\n---\n\nВопрос: ${question}` }],
    max_tokens: 1200,
    agent: 'legal-advisor',
  });
  const srcList = [...kb.files, ...(theses ? ['база знаний по площадкам'] : [])];
  return text + (srcList.length ? `\n\n<i>Источники: ${srcList.join(', ')}</i>` : '');
}

/** Плановых сообщений не шлёт — работает по запросу. */
async function run(): Promise<AgentMessage[]> {
  return [];
}

export const legalAdvisorAgent: Agent = {
  id: 'legal-advisor',
  name: 'Агент 9 · Мини-юрист',
  role: 'Отвечает по налогам/законам/договорам МП, опираясь на документы клиента',
  schedule: 'daily',
  run,
};
