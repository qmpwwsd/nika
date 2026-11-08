// Client for the private app-tier server (ADR 0002). The desktop shell defines window.__NIKA_APP__ = { secret, port }
// before any page script runs. It is copied once into a module-private constant and the global is deleted, so no
// other script on the page (and nothing rendered from a transcript) can read the secret afterwards.
// The browser tier (127.0.0.1:3335) has no such global: isApp is false and appFetch refuses to run, so no
// /api/app request can leave the page there.
const injected = window.__NIKA_APP__;
try {
  delete window.__NIKA_APP__;
} catch {
  // shortcut: a non-configurable global cannot be deleted; the shell defines it configurable, revisit if it ever stops
}
const APP = injected && typeof injected.secret === 'string' && injected.secret ? { secret: injected.secret, port: injected.port } : null;

export const isApp = APP !== null;

/**
 * Request to /api/app/*. Resolves with { status, body, headers } for every HTTP status (the caller decides what a
 * 409 means); rejects only when the network fails or the page is not the app tier.
 */
export async function appFetch(path, { method = 'GET', json, signal, headers } = {}) {
  if (!APP) throw new Error('app tier only');
  if (typeof path !== 'string' || !path.startsWith('/api/app/')) throw new Error('not an app route');
  const head = { ...headers, 'X-Nika-App': APP.secret };
  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    head['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { method, headers: head, body, signal, cache: 'no-store' });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** GET a public route (both tiers) as JSON; throws on a non-2xx status. */
export async function getJSON(path, signal) {
  const res = await fetch(path, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** "light" or "dark" pins the theme; anything else ("system") removes the override so the OS decides. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
