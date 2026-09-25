/**
 * Работа с Chrome (конституция, принцип I): ОБЫЧНЫЙ Google Chrome, отдельный
 * профиль, подключение Playwright через CDP. Никакого headless, прокси и
 * подмены отпечатков. Личный профиль пользователя не трогаем.
 */
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { CONFIG } from './config';
import { localLog } from './api';

let browser: Browser | null = null;

async function cdpAlive(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${CONFIG.debugPort}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

/** Chrome с профилем агента запущен и слушает CDP? Если нет — запустить. */
export async function ensureChrome(): Promise<boolean> {
  if (await cdpAlive()) return true;
  localLog(`[chrome] не отвечает на :${CONFIG.debugPort}, запускаю: ${CONFIG.chromePath}`);
  try {
    const child = spawn(CONFIG.chromePath, [
      `--user-data-dir=${CONFIG.profileDir}`,
      `--remote-debugging-port=${CONFIG.debugPort}`,
      '--no-first-run', '--no-default-browser-check',
      '--restore-last-session=false',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    localLog(`[chrome] запуск не удался: ${(e as Error).message}`);
    return false;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await cdpAlive()) return true;
  }
  return false;
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.debugPort}`, { timeout: 15_000 });
  return browser;
}

/** Новая вкладка в существующем контексте (профиле агента). */
export async function newPage(): Promise<Page> {
  const b = await getBrowser();
  const ctx = b.contexts()[0] ?? await b.newContext();
  return ctx.newPage();
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const randBetween = ([min, max]: [number, number]) => min + Math.random() * (max - min);

/** Признаки капчи/антибота на странице (принцип I: не проходить, а остановиться). */
export function looksLikeChallenge(url: string, bodyText: string): boolean {
  const u = url.toLowerCase();
  const t = bodyText.slice(0, 4000).toLowerCase();
  return u.includes('challenge') || u.includes('captcha')
    || t.includes('подтвердите, что вы не робот') || t.includes('вы не робот')
    || t.includes('access denied') || t.includes('доступ ограничен')
    || t.includes('запросы, поступившие с вашего ip');
}
