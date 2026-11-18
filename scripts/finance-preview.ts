/**
 * Просмотр раздела «Финансы» на своём компьютере до выкладки (19.11.2026).
 * Поднимает только /api/finance на отдельной базе и отдаёт собранный кабинет (dist).
 * В WB, Ozon и Google не ходит. Остальные разделы в просмотре пустые — это нормально.
 *
 *   npm run build
 *   CACHE_DIR=<папка для базы> FIN_EXPORT=<выгрузка таблицы> PORT=8099 npx tsx scripts/finance-preview.ts
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { handleFinance, importAll, allOps } from '../api/_lib/finance';

const PORT = Number(process.env.PORT ?? 8099);
const DIST = path.join(process.cwd(), 'dist');
if (process.env.FIN_EXPORT && !allOps().length) {
  const r = importAll(JSON.parse(readFileSync(process.env.FIN_EXPORT, 'utf8')), 'перенос из таблицы');
  console.warn('[preview] перенесено:', r);
}
const app = express();
app.use(express.json({ limit: '5mb' }));
app.get('/api/auth/check', (_q, res) => res.json({ ok: true, user: { name: 'Владелец (просмотр)', login: 'owner', role: 'owner' } }));
app.all('/api/finance/*', async (req, res) => {
  const parts = req.path.replace(/^\/api\//, '').split('/').filter(Boolean);
  const r = await handleFinance(parts, req.method, req.query, req.body, 'Владелец (просмотр)');
  res.status(r.status).json(r.json);
});
app.all('/api/*', (_q, res) => res.status(404).json({ error: 'not_found', reason: 'в просмотре работает только раздел «Финансы»' }));
app.use(express.static(DIST, { index: false }));
app.get('*', (_q, res) => res.sendFile(path.join(DIST, 'index.html')));
app.listen(PORT, '127.0.0.1', () => console.warn(`[preview] «Финансы»: http://localhost:${PORT}`));
