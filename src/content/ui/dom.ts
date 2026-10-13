/** Small helper for building DOM without a framework. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | number | ((event: never) => void) | undefined> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, '').toLowerCase(), value as EventListener);
    else if (key === 'class') el.className = String(value);
    else if (key === 'html') el.innerHTML = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

export function formatRemaining(seconds: number): string {
  if (seconds < 50) return 'Under a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min left`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
