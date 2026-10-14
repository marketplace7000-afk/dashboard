// Импортируется ПЕРВЫМ в check-ads-store.ts: import-ы поднимаются выше любого
// кода, поэтому CACHE_DIR, заданный в теле проверки, модули уже не видели и
// писали в рабочий .av-cache. Отдельный модуль выполняется до остальных.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'av-check-ads2-'));
// Привязки конкурентов (api/_lib/competitorWatch.ts) — тоже во временную папку.
process.env.COMPETITORS_FILE = join(process.env.CACHE_DIR, 'competitors.json');
