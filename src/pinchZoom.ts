// Масштаб двумя пальцами на телефоне (просьба владельца 21.11.2026).
// Обычный масштаб браузера не даёт отдалить страницу дальше «во весь экран», а таблицы
// хочется охватить целиком. Поэтому жест двумя пальцами меняет ширину, под которую
// свёрстана страница (meta viewport): свёл пальцы — страница шире и мельче (видно больше),
// развёл — уже и крупнее, текст переносится и не уезжает за край. Масштаб запоминается.

const KEY = 'av-phone-zoom';
const MAX_W = 768;        // шире — включится вид для компьютера с боковым меню
const MAX_ZOOM = 1.5;     // крупнее — колонки становятся слишком узкими

function baseWidth(): number {
  const a = screen.width, b = screen.height;
  return matchMedia('(orientation: landscape)').matches ? Math.max(a, b) : Math.min(a, b);
}

export function setupPinchZoom(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta || !('ontouchstart' in window)) return;
  if (baseWidth() > MAX_W) return; // планшеты и компьютеры — как было

  let zoom = 1;
  try { zoom = Number(localStorage.getItem(KEY)) || 1; } catch (e) { console.warn('[zoom] не прочитан сохранённый масштаб:', e); }

  const clamp = (z: number) => {
    const base = baseWidth();
    return Math.min(MAX_ZOOM, Math.max(base / MAX_W, z));
  };
  let applied = 0;
  const apply = () => {
    zoom = clamp(zoom);
    const w = Math.round(baseWidth() / zoom);
    if (Math.abs(w - applied) < 4) return;
    applied = w;
    meta.content = Math.abs(zoom - 1) < 0.02
      ? 'width=device-width, initial-scale=1.0'
      : `width=${w}`;
  };
  const save = () => { try { localStorage.setItem(KEY, String(zoom)); } catch (e) { console.warn('[zoom] масштаб не сохранён:', e); } };

  apply();
  addEventListener('orientationchange', () => setTimeout(() => { applied = 0; apply(); }, 300));

  const scaleNow = () => (applied ? baseWidth() / applied : 1);
  let startDist = 0, startZoom = 1, frame = 0;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  document.addEventListener('touchstart', e => {
    if (e.touches.length === 2) { startDist = dist(e.touches) * scaleNow(); startZoom = zoom; }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !startDist) return;
    e.preventDefault(); // жест наш — встроенный масштаб браузера не включаем
    // Расстояние между пальцами — в экранных точках (CSS-пиксели меняются вместе с масштабом).
    const k = (dist(e.touches) * scaleNow()) / startDist;
    zoom = clamp(startZoom * k);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); });
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (startDist && e.touches.length < 2) { startDist = 0; save(); }
  }, { passive: true });

  // iPhone: системный жест масштаба приходит отдельно — гасим, раз масштабом управляем мы.
  document.addEventListener('gesturestart', e => e.preventDefault());
}
