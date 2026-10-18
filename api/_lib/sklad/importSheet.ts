/**
 * Импорт справочника товаров из Google-таблицы «Склад (orig)» (SKLAD_SHEET_ID).
 *
 * Пока идёт переход (этапы 1–4 плана), таблица главная: сотрудница склада
 * заполняет габариты, вес и ссылки на листе «Склад Уфа», закупщик — ссылки на
 * Яндекс Диск. Импорт можно запускать сколько угодно раз — он только
 * досинхронизирует:
 *   • артикул есть на «Складе Уфа» → товар активный, поля из таблицы
 *     (непустые) переписывают наши;
 *   • артикул есть только в «Базе ШК» (выведен из ассортимента) → создаём
 *     архивным, чтобы при переносе истории (этап 2) движениям было к чему
 *     привязаться — в журналах таких 126;
 *   • наш товар из таблицы пропал со «Склада Уфа» → в архив (не удаляем).
 *
 * Колонки ищутся по заголовкам (строки 2–3), а не по номерам: таблица —
 * живой документ, колонки уже сдвигались (см. scripts/check-sklad-layout.ts).
 */
import { getSkladDb } from './db';
import { audit } from './audit';
import { normArticle, normBarcode } from './catalog';
import type { AuthUser } from './users';

export const MASTER_SHEET = 'Склад Уфа';
export const BARCODE_SHEET = 'База ШК(парсер)';

export type SheetProduct = {
  article: string; name: string; barcode: string;
  lengthCm: number | null; widthCm: number | null; heightCm: number | null; weightG: number | null;
  perBox: number | null; photoUrl: string; diskUrl: string;
};

export type MasterLayout = {
  article: number; name: number; barcode: number; length: number; width: number; height: number;
  weight: number; perBox: number; photo: number; link: number; firstDataRow: number;
};

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Найти колонки «Склада Уфа» по заголовкам. Бросает, если нет артикула. */
export function detectMasterLayout(rows: any[][]): MasterLayout {
  const h2 = (rows[1] ?? []).map(norm);
  const h3 = (rows[2] ?? []).map(norm);
  const find = (names: string[], row = h2) => row.findIndex(c => names.includes(c));
  const L: MasterLayout = {
    article: find(['sku ozon/ям/wb', 'sku', 'артикул']),
    name: find(['name', 'название', 'наименование']),
    barcode: find(['баркод', 'штрихкод', 'штрих-код']),
    length: find(['длина']),
    width: find(['ширина']),
    height: find(['высота']),
    weight: find(['вес']),
    perBox: find(['в коробке'], h3),
    photo: find(['pic', 'фото']),
    link: find(['link', 'ссылка']),
    firstDataRow: 3, // строка 4 листа
  };
  if (L.article < 0) throw new Error(`на листе «${MASTER_SHEET}» не найден заголовок артикула (ожидали «SKU Ozon/ЯМ/WB» во 2-й строке)`);
  return L;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) && x > 0 ? x : null;
};

/** Адрес картинки из формулы =IMAGE("url"…) или сам URL. */
export function imageUrl(v: unknown): string {
  const s = String(v ?? '');
  const m = s.match(/IMAGE\(\s*"([^"]+)"/i);
  if (m) return m[1];
  return /^https?:\/\//i.test(s.trim()) ? s.trim() : '';
}

/** Строки «Склада Уфа» (значения + формулы колонки фото) → товары. */
export function parseMaster(values: any[][], formulas: any[][]): SheetProduct[] {
  const L = detectMasterLayout(values);
  const out: SheetProduct[] = [];
  const seen = new Set<string>();
  for (let i = L.firstDataRow; i < values.length; i++) {
    const r = values[i] ?? [];
    const article = normArticle(r[L.article]);
    if (!article || seen.has(article.toUpperCase())) continue;
    seen.add(article.toUpperCase());
    const cell = (idx: number) => (idx >= 0 ? r[idx] : undefined);
    const link = String(cell(L.link) ?? '').trim();
    out.push({
      article,
      name: String(cell(L.name) ?? '').trim(),
      barcode: normBarcode(cell(L.barcode)),
      lengthCm: num(cell(L.length)), widthCm: num(cell(L.width)), heightCm: num(cell(L.height)),
      weightG: num(cell(L.weight)),
      perBox: (() => { const x = num(cell(L.perBox)); return x === null ? null : Math.round(x); })(),
      photoUrl: L.photo >= 0 ? imageUrl(formulas[i]?.[L.photo]) : '',
      diskUrl: /^https?:\/\//i.test(link) ? link : '',
    });
  }
  return out;
}

/** «База ШК(парсер)» A:B → артикул → баркод (там и выведенные товары). */
export function parseBarcodeBase(rows: any[][]): Map<string, { article: string; barcode: string }> {
  const out = new Map<string, { article: string; barcode: string }>();
  for (let i = 1; i < rows.length; i++) {
    const article = normArticle(rows[i]?.[0]);
    if (!article) continue;
    const key = article.toUpperCase();
    if (!out.has(key)) out.set(key, { article, barcode: normBarcode(rows[i]?.[1]) });
  }
  return out;
}

export type ImportReport = {
  dryRun: boolean;
  master: number;
  created: string[];
  updated: Array<{ article: string; fields: string[] }>;
  reactivated: string[];
  archivedNew: string[];
  archivedGone: string[];
  barcodesAdded: number;
  barcodeConflicts: string[];
  warnings: string[];
};

const FIELD_COLS: Array<[keyof SheetProduct, string]> = [
  ['name', 'name'], ['lengthCm', 'length_cm'], ['widthCm', 'width_cm'], ['heightCm', 'height_cm'],
  ['weightG', 'weight_g'], ['perBox', 'per_box'], ['photoUrl', 'photo_url'], ['diskUrl', 'disk_url'],
];

/**
 * Применить к базе. dryRun = true — только посчитать, что изменится
 * (транзакция откатывается), чтобы показать на экране перед импортом.
 */
export function applyImport(master: SheetProduct[], base: Map<string, { article: string; barcode: string }>, by: AuthUser, dryRun: boolean): ImportReport {
  const d = getSkladDb();
  const rep: ImportReport = { dryRun, master: master.length, created: [], updated: [], reactivated: [], archivedNew: [],
    archivedGone: [], barcodesAdded: 0, barcodeConflicts: [], warnings: [] };
  const now = Date.now();
  const byArticle = (a: string) => d.prepare('SELECT * FROM products WHERE article = ?').get(a) as any;
  const addBarcode = (pid: number, article: string, code: string) => {
    if (code.length < 6) return;
    const owner = d.prepare('SELECT b.product_id, p.article FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE b.barcode = ?').get(code) as any;
    if (owner) {
      if (owner.product_id !== pid) rep.barcodeConflicts.push(`${code}: в таблице у ${article}, в базе у ${owner.article}`);
      return;
    }
    const hasMain = d.prepare(`SELECT 1 FROM product_barcodes WHERE product_id = ? AND kind = 'main'`).get(pid);
    d.prepare('INSERT INTO product_barcodes (barcode, product_id, kind, created_at) VALUES (?, ?, ?, ?)').run(code, pid, hasMain ? 'extra' : 'main', now);
    rep.barcodesAdded++;
  };

  d.exec('BEGIN IMMEDIATE');
  try {
    const inMaster = new Set<string>();
    for (const p of master) {
      inMaster.add(p.article.toUpperCase());
      const cur = byArticle(p.article);
      if (!cur) {
        const r = d.prepare(`INSERT INTO products (article, name, status, length_cm, width_cm, height_cm, weight_g, per_box,
          photo_url, disk_url, source, created_at, updated_at, updated_by) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 'sheet', ?, ?, ?)`)
          .run(p.article, p.name, p.lengthCm, p.widthCm, p.heightCm, p.weightG, p.perBox, p.photoUrl, p.diskUrl, now, now, by.id);
        const pid = Number(r.lastInsertRowid);
        addBarcode(pid, p.article, p.barcode || base.get(p.article.toUpperCase())?.barcode || '');
        audit(by, 'product', pid, 'import-create', { article: [null, p.article] });
        rep.created.push(p.article);
        continue;
      }
      const set: string[] = [];
      const args: unknown[] = [];
      const diff: Record<string, [unknown, unknown]> = {};
      for (const [field, col] of FIELD_COLS) {
        const v = p[field];
        if (v === null || v === '' || v === cur[col]) continue; // пустое в таблице не затирает наше
        set.push(`${col} = ?`); args.push(v); diff[field] = [cur[col], v];
      }
      if (cur.status === 'archived') { set.push(`status = 'active'`); diff.status = [cur.status, 'active']; rep.reactivated.push(p.article); }
      if (set.length) {
        d.prepare(`UPDATE products SET ${set.join(', ')}, source = 'sheet', updated_at = ?, updated_by = ? WHERE id = ?`).run(...args, now, by.id, cur.id);
        audit(by, 'product', cur.id, 'import-update', diff);
        const fields = Object.keys(diff).filter(f => f !== 'status');
        if (fields.length) rep.updated.push({ article: p.article, fields });
      }
      addBarcode(cur.id, p.article, p.barcode);
    }

    // Выведенные из ассортимента: есть в «Базе ШК», нет на «Складе Уфа».
    for (const [key, b] of base) {
      if (inMaster.has(key) || byArticle(b.article)) continue;
      const r = d.prepare(`INSERT INTO products (article, status, source, notes, created_at, updated_at, updated_by)
        VALUES (?, 'archived', 'sheet', 'Нет на листе «Склад Уфа» — выведен из ассортимента (импорт из «Базы ШК»)', ?, ?, ?)`)
        .run(b.article, now, now, by.id);
      const pid = Number(r.lastInsertRowid);
      addBarcode(pid, b.article, b.barcode);
      audit(by, 'product', pid, 'import-create', { article: [null, b.article], status: [null, 'archived'] });
      rep.archivedNew.push(b.article);
    }

    // Пропали со «Склада Уфа» — в архив. Только то, что пришло из таблицы:
    // заведённые на сайте вручную (черновики новинок) не трогаем.
    if (master.length >= 10) {
      const gone = d.prepare(`SELECT id, article, status FROM products WHERE source = 'sheet' AND status <> 'archived'`).all() as any[];
      for (const g of gone) {
        if (inMaster.has(String(g.article).toUpperCase())) continue;
        d.prepare(`UPDATE products SET status = 'archived', updated_at = ?, updated_by = ? WHERE id = ?`).run(now, by.id, g.id);
        audit(by, 'product', g.id, 'import-archive', { status: [g.status, 'archived'] });
        rep.archivedGone.push(g.article);
      }
    } else {
      rep.warnings.push(`На листе «${MASTER_SHEET}» всего ${master.length} товаров — архивирование пропавших пропущено, похоже на сбой чтения`);
    }

    if (dryRun) d.exec('ROLLBACK'); else d.exec('COMMIT');
    return rep;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Прочитать таблицу и импортировать. */
export async function importFromSheet(by: AuthUser, dryRun: boolean): Promise<ImportReport> {
  const id = (process.env.SKLAD_SHEET_ID || '').trim();
  if (!id) throw new Error('SKLAD_SHEET_ID не задан на сервере');
  const { hasServiceAccount, readSheetRange } = await import('../googleSheetsApi');
  if (!hasServiceAccount()) throw new Error('ключ сервисного аккаунта Google не настроен');
  const [values, formulas, baseRows] = await Promise.all([
    readSheetRange(id, `'${MASTER_SHEET}'!A1:AH1000`),
    readSheetRange(id, `'${MASTER_SHEET}'!A1:A1000`, 'FORMULA'),
    readSheetRange(id, `'${BARCODE_SHEET}'!A1:B3000`),
  ]);
  const master = parseMaster(values, formulas);
  const base = parseBarcodeBase(baseRows);
  return applyImport(master, base, by, dryRun);
}
