/**
 * Письмо с вложениями через SMTP почтового ящика магазина (20.11.2026, «Документы» в чатах).
 * Без зависимостей: TLS-соединение (порт 465), AUTH LOGIN, письмо в MIME.
 * Настройки — в .env на сервере (владелец вносит сам, пароль приложения ящика):
 *   SMTP_USER — адрес ящика (shop@yandex.ru), SMTP_PASS — пароль приложения,
 *   SMTP_HOST (по умолчанию smtp.yandex.ru), SMTP_PORT (465), SMTP_FROM_NAME (подпись отправителя).
 */
import { connect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';

export type MailAttachment = { name: string; mime: string; data: Buffer };
export type Mail = { to: string; subject: string; text: string; attachments: MailAttachment[] };

export function mailReady(): boolean {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function mailFrom(): string { return process.env.SMTP_USER || ''; }

export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Адрес для журнала: «iv***@mail.ru». */
export function maskEmail(e: string): string {
  const [u, d] = String(e).split('@');
  return d ? `${u.slice(0, 2)}***@${d}` : '***';
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

/** Письмо целиком в MIME (multipart/mixed: текст + вложения). Отдельно — для проверки в check-chat-docs. */
export function buildMime(m: Mail, from: string, fromName: string): string {
  const bnd = `av-${randomBytes(12).toString('hex')}`;
  const host = from.split('@')[1] || 'localhost';
  const head = [
    `From: ${word(fromName)} <${from}>`,
    `To: <${m.to}>`,
    `Subject: ${word(m.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(10).toString('hex')}@${host}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${bnd}"`,
  ];
  const parts = [
    [`--${bnd}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(m.text))].join('\r\n'),
    ...m.attachments.map(a => [
      `--${bnd}`,
      `Content-Type: ${a.mime}; name="${word(a.name)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${word(a.name)}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      '',
      wrap(a.data.toString('base64')),
    ].join('\r\n')),
  ];
  return `${head.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${bnd}--\r\n`;
}

/** Ответ SMTP-сервера: строки «250-…» продолжаются, «250 …» — последняя. */
function reader(sock: TLSSocket) {
  let buf = '';
  let waiting: ((v: { code: number; text: string }) => void) | null = null;
  let failed: Error | null = null;
  let failWaiter: ((e: Error) => void) | null = null;
  const tryResolve = () => {
    if (!waiting) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const text = lines.slice(0, i + 1).join('\n');
        buf = lines.slice(i + 1).join('\r\n');
        const w = waiting; waiting = null; failWaiter = null;
        w({ code: Number(lines[i].slice(0, 3)), text });
        return;
      }
    }
  };
  sock.on('data', d => { buf += d.toString('utf8'); tryResolve(); });
  const onFail = (e: Error) => { failed = e; if (failWaiter) { const f = failWaiter; failWaiter = null; waiting = null; f(e); } };
  sock.on('error', onFail);
  sock.on('close', () => onFail(new Error('почтовый сервер закрыл соединение')));
  return (): Promise<{ code: number; text: string }> => new Promise((res, rej) => {
    if (failed) return rej(failed);
    waiting = res; failWaiter = rej; tryResolve();
  });
}

export async function sendMail(m: Mail): Promise<void> {
  if (!mailReady()) throw new Error('Почта магазина не подключена');
  if (!EMAIL_RE.test(m.to)) throw new Error('Неверный адрес почты');
  const host = process.env.SMTP_HOST || 'smtp.yandex.ru';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER!;
  const mime = buildMime(m, user, process.env.SMTP_FROM_NAME || 'Avto Vibe');
  const sock = connect({ host, port, servername: host });
  sock.setTimeout(120_000, () => sock.destroy(new Error('почтовый сервер не отвечает')));
  const next = reader(sock);
  const step = async (cmd: string | null, ok: number[], what: string) => {
    if (cmd !== null) sock.write(cmd + '\r\n');
    const r = await next();
    if (!ok.includes(r.code)) throw new Error(`почта: ${what} — ${r.text.slice(0, 200)}`);
    return r;
  };
  try {
    await step(null, [220], 'приветствие');
    await step('EHLO e-avtovibe.ru', [250], 'EHLO');
    await step('AUTH LOGIN', [334], 'вход');
    await step(b64(user), [334], 'вход');
    await step(b64(process.env.SMTP_PASS!), [235], 'вход (проверьте пароль приложения)');
    await step(`MAIL FROM:<${user}>`, [250], 'отправитель');
    await step(`RCPT TO:<${m.to}>`, [250, 251], 'получатель');
    await step('DATA', [354], 'DATA');
    // Строки base64 не начинаются с точки, но заголовки/текст на всякий случай «удваивают» точку по правилу SMTP.
    sock.write(mime.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
    await step(null, [250], 'письмо не принято');
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}
