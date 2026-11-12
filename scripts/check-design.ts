/**
 * Единый стиль кабинета (12.11.2026). Запуск: npm run check
 *
 * Правила владельца: один шрифт на весь кабинет (Golos Text), подписи не мельче 15 px.
 * Скрипт читает все стили и экраны и падает, если новое место нарушает правило, —
 * так новые разделы получают единый стиль с первого дня, а не после жалобы.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIN_PX = 15;
/** Разрешённые исключения: счётчики-значки, буква в аватаре, подпись на фото, заголовки меню капителью. */
const SMALL_OK = ['.ad2-badge', '.nav-section', '.profile-avatar', '.rv-media-tag', '.rv-badge', '.act-mark'];
/** Раздел «Склад» в архиве (скрыт): его стили не правим, пока раздел не вернули. */
const ARCHIVED = /^\.sk-/;
/** Шрифты, которые можно называть явно: основной и моноширинный для кодов и ключей. */
const FONT_OK = /Golos Text|inherit|monospace|var\(/;

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(f)) out.push(p);
  }
  return out;
}

const problems: string[] = [];

for (const file of walk('src', /\.css$/)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const sel = line.trim();
    if (ARCHIVED.test(sel)) return;
    const size = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(line);
    if (size && Number(size[1]) < MIN_PX && !SMALL_OK.some(s => line.includes(s))) {
      problems.push(`${file}:${i + 1} — шрифт ${size[1]} px мельче ${MIN_PX} px: ${sel.slice(0, 70)}`);
    }
    const fam = /font-family:\s*([^;}]+)/.exec(line);
    // Первая строка в списке шрифтов решает, чем набран текст; body задаёт основной шрифт.
    if (fam && !line.includes('@font-face') && !FONT_OK.test(fam[1].split(',')[0]) && !/^\s*font-family: -apple-system/.test(line)) {
      problems.push(`${file}:${i + 1} — чужой шрифт «${fam[1].split(',')[0].trim()}»: ${sel.slice(0, 70)}`);
    }
  });
}

for (const file of walk('src', /\.tsx$/)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/fontSize:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?/g)) {
      if (Number(m[1]) < MIN_PX && !line.includes('design-ok')) problems.push(`${file}:${i + 1} — fontSize ${m[1]} мельче ${MIN_PX}`);
    }
    const fam = /fontFamily:\s*['"]([^'"]+)['"]/.exec(line);
    if (fam && !FONT_OK.test(fam[1])) problems.push(`${file}:${i + 1} — чужой шрифт «${fam[1].split(',')[0]}»`);
  });
}

if (problems.length) {
  console.log('Единый стиль нарушен:');
  for (const p of problems) console.log('  ✗ ' + p);
  console.log(`\nПравило: один шрифт (Golos Text), текст не мельче ${MIN_PX} px. Исключения — в списке SMALL_OK этого файла.`);
  process.exit(1);
}
console.log('  ✓ один шрифт, подписи не мельче 15 px\n\nЕдиный стиль: в порядке.');
