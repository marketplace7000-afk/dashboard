import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// ─────────────────────────────────────────────────────────────────────────
// Vite dev-proxy для локальной разработки БЕЗ `vercel dev`.
// Подставляет заголовки авторизации из .env и проксирует в WB/Ozon hosts.
//
// На проде эти же пути обрабатывают Vercel Functions из api/ —
// с серверным кэшем + retry. См. vercel.json (rewrites).
// ─────────────────────────────────────────────────────────────────────────

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Хелпер: WB прокси для одного scope с подменой токена.
  // Поддерживает X-Wb-Token override (клиентский токен из UI Настроек).
  const wbProxy = (prefix: string, target: string, scope?: string) => ({
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(new RegExp(`^${prefix}`), ''),
    configure: (proxy: any) => {
      proxy.on('proxyReq', (proxyReq: any, req: any) => {
        // Если клиент прислал X-Wb-Token — используем его, иначе env
        const clientToken = req.headers['x-wb-token'];
        const scopedToken = scope ? env[`VITE_WB_TOKEN_${scope.toUpperCase()}`] : '';
        const token = clientToken || scopedToken || env.VITE_WB_TOKEN || '';
        if (token) proxyReq.setHeader('Authorization', String(token));
        proxyReq.removeHeader('x-wb-token');
      });
    },
  });

  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: true,
      proxy: {
        // ─── WB API ─────────────────────────────────────────────────────
        '/wb/common':     wbProxy('/wb/common',     'https://common-api.wildberries.ru', 'common'),
        '/wb/content':    wbProxy('/wb/content',    'https://content-api.wildberries.ru', 'content'),
        '/wb/statistics': wbProxy('/wb/statistics', 'https://statistics-api.wildberries.ru', 'stats'),
        '/wb/feedbacks':  wbProxy('/wb/feedbacks',  'https://feedbacks-api.wildberries.ru', 'feedbacks'),
        '/wb/discounts':  wbProxy('/wb/discounts',  'https://discounts-prices-api.wildberries.ru', 'prices'),
        '/wb/promotion':  wbProxy('/wb/promotion',  'https://advert-api.wildberries.ru', 'promotion'),
        '/wb/analytics':  wbProxy('/wb/analytics',  'https://seller-analytics-api.wildberries.ru', 'analytics'),
        '/wb/supplies':   wbProxy('/wb/supplies',   'https://supplies-api.wildberries.ru', 'supplies'),
        '/wb/finance':    wbProxy('/wb/finance',    'https://finance-api.wildberries.ru', 'finance'),

        // ─── Ozon Seller API ────────────────────────────────────────────
        '/ozon': {
          target: 'https://api-seller.ozon.ru',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/ozon/, ''),
          headers: {
            'Client-Id': env.VITE_OZON_CLIENT_ID ?? '',
            'Api-Key': env.VITE_OZON_API_KEY ?? '',
            'Content-Type': 'application/json',
          },
        },

        // ─── Ozon Performance API ────────────────────────────────────────
        // Внимание: ПОЛНОЦЕННАЯ работа Performance API требует серверного
        // OAuth (наш api/ozon-perf/[...slug].ts). При запуске через `vite dev`
        // здесь только пробрасываем запросы — фронт сам пытается делать OAuth.
        // Рекомендуется запускать локалку через `vercel dev` (см. README).
        '/ozon-perf': {
          target: 'https://api-performance.ozon.ru',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/ozon-perf/, ''),
        },
      },
    },
  };
});
