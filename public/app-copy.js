// The Add to Applications notice (docs/design/spec.md 3.14, ADR 0011): which banner the dashboard shows for the `appCopy`
// object of GET /api/app/me, and its fixed copy. Pure on purpose: no network, storage or timers, so it loads on both tiers
// and runs in tests; the two POSTs live in project.js (app tier only). Every string is static copy plus the server's version
// number, and the page renders it through h() (textContent).

const BANNERS = {
  add: {
    mode: 'add', title: 'Add nika to Applications', text: 'so Spotlight and Launchpad can find it.',
    primary: { label: 'Add to Applications', busy: 'Adding…' }, ghost: { label: 'Not now' },
  },
  update: {
    mode: 'update', text: 'Update the app in Applications to match.',
    primary: { label: 'Update app', busy: 'Updating…' }, ghost: { label: 'Not now' },
  },
};

const FAILED = "nika couldn't copy the app to Applications.";
const ERRORS = {
  'foreign-target': "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace. Move it away, then try again.",
  'no-source': "nika can't find its own app to copy. Reinstall it with Homebrew.",
  'copy-busy': 'nika is already copying the app.',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The banner to show, or null. `appCopy` is /api/app/me's object (anything else shows nothing); `ui.hidden` = "Not now"
 * was pressed this launch. Add: no copy yet, a source exists, not dismissed. Update: a copy nika made is another version.
 */
export function copyBanner(appCopy, ui = {}) {
  if (!isObj(appCopy) || ui.hidden || typeof appCopy.available !== 'string' || !appCopy.available) return null;
  if (appCopy.state === 'missing' && appCopy.dismissed !== true) return { ...BANNERS.add };
  if (appCopy.state === 'stale' && appCopy.managed === true) return { ...BANNERS.update, title: `nika ${appCopy.available} is installed.` };
  return null;
}

/** The toast for a 200: Add, Update, or Update when this server runs from the replaced copy (restart). */
export function copyToast(mode, body) {
  if (mode === 'add') return 'nika is in Applications. Open it from Spotlight or Launchpad.';
  return body?.restart === true ? `Updated to ${body.version}. Quit and reopen nika to use it.` : `Updated the app in Applications to ${body?.version}.`;
}

/** Fixed copy for a failed install, chosen by the server's error code only; the server's own text is never shown. */
export function copyErrorText(res) {
  const code = res?.body?.error;
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : FAILED;
}
