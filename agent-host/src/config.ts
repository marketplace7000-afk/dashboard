import 'dotenv/config';

function req(name: string): string {
  const v = (process.env[name] || '').trim();
  if (!v) { console.error(`[config] не задана переменная ${name} (см. .env.example)`); process.exit(1); }
  return v;
}

export const CONFIG = {
  name: (process.env.AGENT_NAME || 'home-pc').trim(),
  apiUrl: req('DASHBOARD_API_URL').replace(/\/+$/, ''),
  apiKey: req('AGENT_API_KEY'),
  chromePath: (process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe').trim(),
  profileDir: (process.env.CHROME_PROFILE_DIR || 'C:\\agent\\chrome-profile').trim(),
  debugPort: Number(process.env.CHROME_DEBUG_PORT) || 9222,
  pollSec: Math.max(15, Number(process.env.POLL_INTERVAL_SEC) || 45),
};
