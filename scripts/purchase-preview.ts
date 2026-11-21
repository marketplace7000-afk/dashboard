/**
 * Просмотр раздела «Закупки» на своём компьютере до выкладки (19.11.2026).
 * Отдаёт собранный кабинет (dist) и готовый ответ /api/purchase из файла — расчёт, снятый на сервере
 * (данные таблиц и РНП есть только там). Настройки и отметки в просмотре не сохраняются.
 *
 *   npm run build
 *   PUR_JSON=<purchase.json> SEASON_JSON=<season.json> PORT=8098 npx tsx scripts/purchase-preview.ts
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8098);
const DIST = path.join(process.cwd(), 'dist');
const data = JSON.parse(readFileSync(String(process.env.PUR_JSON), 'utf8'));
const app = express();
app.use(express.json());
app.get('/api/auth/check', (_q, res) => res.json({ ok: true, user: { name: 'Владелец (просмотр)', login: 'owner', role: 'owner' } }));
app.get('/api/purchase', (_q, res) => res.json(data));
// «Сезонность» (21.11): SEASON_JSON — ответ /api/purchase/season, снятый на сервере.
const season = process.env.SEASON_JSON ? JSON.parse(readFileSync(process.env.SEASON_JSON, 'utf8')) : { ok: true, builtAt: new Date().toISOString(), categories: [], runs: [], notes: ['в просмотре нет данных сезонности'] };
app.get('/api/purchase/season', (_q, res) => res.json(season));
app.post('/api/purchase/season/:a', (_q, res) => res.json({ ok: true }));
app.post('/api/purchase/:a', (_q, res) => res.json({ ok: true }));
app.all('/api/*', (_q, res) => res.status(404).json({ error: 'not_found', reason: 'в просмотре работает только раздел «Закупки»' }));
app.use(express.static(DIST, { index: false }));
app.get('*', (_q, res) => res.sendFile(path.join(DIST, 'index.html')));
app.listen(PORT, '127.0.0.1', () => console.warn(`[preview] «Закупки»: http://localhost:${PORT}`));
