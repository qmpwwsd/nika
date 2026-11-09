// The Keyboard shortcuts window and the key rules around it (docs/design/spec.md 3.13 and 4.6), shared by the dashboard and the
// session window. Everything except openShortcuts is pure, so Node tests it (test/shortcuts.test.js). The content is static copy
// kept here; nothing in the window comes from the server. ASCII only: key glyphs are escapes, because the session window's
// files are scanned for invisible characters.
import { h } from './dom.js';

const CMD = '\u2318';
const SHIFT = '\u21e7';
const CTRL = '\u2303';
const LEFT = '\u2190';
const RIGHT = '\u2192';
const UP = '\u2191';
const DOWN = '\u2193';

/** True on macOS. `nav` is the page's navigator; the client hints win over the older platform string. */
export function isMac(nav) {
  return /Mac|iPhone|iPad/i.test(nav?.userAgentData?.platform ?? nav?.platform ?? '');
}

// ---- the tables (spec 4.6) ---------------------------------------------------------------------------------------------------
// keys: per platform, a list of alternatives, each a list of keys joined by "+". `alt` is what joins the alternatives (" or ", or a
// space for a set of keys such as the arrows). Mod is resolved here: the glyph on macOS, Ctrl elsewhere.
const mod = (key) => ({ mac: [[CMD, key]], other: [['Ctrl', key]] });
const one = (...keys) => ({ mac: [keys], other: [keys] });
const alts = (...list) => ({ mac: list.map((k) => [k]), other: list.map((k) => [k]) });
const HELP = { mac: [['?'], [CMD, '/']], other: [['?'], ['Ctrl', '/']] };
const BACK = { mac: [[CMD, '[']], other: [['Alt', LEFT]] };
const row = (window, tier, group, name, keys, description, alt = ' or ') => ({ window, tier, group, name, keys, description, alt });

export const SHORTCUTS = [
  row('dashboard', 'app', 'Navigation', 'Dashboard', mod('1'), 'Show all projects and agents'),
  row('dashboard', 'app', 'Navigation', 'Settings', mod(','), 'Open Settings'),
  row('dashboard', 'app', 'Navigation', 'Add project', mod('O'), 'Choose a folder to add as a project'),
  row('dashboard', 'app', 'Navigation', 'Filter agents', mod('F'), 'Move to the agent filter (dashboard)'),
  row('dashboard', 'app', 'Navigation', 'Back', BACK, 'Go back to the dashboard (project view, Settings)'),
  row('dashboard', 'app', 'Navigation', 'Keyboard shortcuts', HELP, 'Show this list'),
  row('dashboard', 'app', 'Dialogs and menus', 'Run the main action', mod('Enter'), 'Spawn, save or apply in the open dialog or in Settings'),
  row('dashboard', 'app', 'Dialogs and menus', 'Close', one('Esc'), 'Close the open menu or dialog'),
  // the browser tier cannot store the Settings switch, so "?" is app-tier only
  row('dashboard', 'browser', 'Navigation', 'Keyboard shortcuts', mod('/'), 'Show this list'),
  row('dashboard', 'browser', 'Dialogs and menus', 'Close', one('Esc'), 'Close the open menu'),

  row('session', 'app', 'Window', 'Back', BACK, 'Back to the dashboard'),
  row('session', 'app', 'Window', 'Keyboard shortcuts', HELP, 'Show this list'),
  row('session', 'app', 'Message box', 'Send', one('Enter'), 'Send the text, then Enter, to Claude (empty box: Enter only)'),
  row('session', 'app', 'Message box', 'New line', { mac: [[SHIFT, 'Enter']], other: [['Shift', 'Enter']] }, 'Start a new line in the message box'),
  row('session', 'app', 'Message box', 'Press Esc in Claude', one('Esc'), "Stop Claude's turn or close Claude's menu (when nothing in nika is open)"),
  row('session', 'app', 'Message box', 'Interrupt', { mac: [[CTRL, 'C']], other: [['Ctrl', 'C']] }, 'Send Ctrl-C to Claude (when no text is selected)'),
  row('session', 'app', 'Message box', 'Commands', one('/'), 'Open the command list (at the start of an empty box)'),
  row('session', 'app', 'Message box', 'Type into the pane', { mac: [[CTRL, ']']], other: [['Ctrl', ']']] }, "Send every key straight to Claude's terminal"),
  row('session', 'app', 'Typing into the pane', 'Stop typing into the pane', { mac: [[CTRL, ']']], other: [['Ctrl', ']']] }, 'Keys go to the message box again'),
  row('session', 'app', 'Mode switcher', 'Move between modes', alts(LEFT, RIGHT, 'Home', 'End'), 'Moves focus; does not switch', ' '),
  row('session', 'app', 'Mode switcher', 'Switch', alts('Enter', 'Space'), 'Switch to the focused mode'),
  row('session', 'app', 'Command list', 'Move', alts(UP, DOWN), 'Move through the commands', ' '),
  row('session', 'app', 'Command list', 'Insert', alts('Enter', 'Tab'), 'Put the command in the message box'),
  row('session', 'app', 'Command list', 'Close', one('Esc'), 'Close the list and keep the text'),
];

/**
 * The rows of one window for one tier and platform, grouped in first-seen order:
 * [{ group, rows: [{ name, keys: string[][], alt, description }] }]. An unknown window or tier gives [].
 */
export function shortcutsFor({ window: win, tier, mac } = {}, list = SHORTCUTS) {
  const groups = new Map();
  for (const r of list) {
    if (r.window !== win || (r.tier !== tier && r.tier !== 'both')) continue;
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push({ name: r.name, keys: mac ? r.keys.mac : r.keys.other, alt: r.alt, description: r.description });
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

// ---- key rules ---------------------------------------------------------------------------------------------------------------

/** Input, textarea, select, contenteditable, or the terminal mirror (`#term` in the session window): where a bare key is typing. */
export function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  return Boolean(el.closest?.('#term'));
}

/**
 * Spec 4.6. Never while a dialog is open (the shortcuts window itself included). Mod+/ (Command on macOS, Ctrl elsewhere, Shift
 * allowed, nothing else) works in text entry and with the setting off; on Linux it is not available in passthrough, where Ctrl+] is
 * the only key nika keeps. "?" (no Ctrl, Command or Alt) needs the setting on, no text entry and no passthrough.
 */
export function wantsHelp(e, { mac, singleKey, textEntry, passthrough, dialogOpen }) {
  if (dialogOpen) return false;
  const modKey = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (e.key === '/' && modKey && !e.altKey) return mac || !passthrough;
  return e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && Boolean(singleKey) && !textEntry && !passthrough;
}

/** Command+[ on macOS, Alt+Left elsewhere, nothing else held; not in passthrough and not over a dialog. */
export function wantsBack(e, { mac, passthrough, dialogOpen }) {
  if (passthrough || dialogOpen || e.shiftKey || e.ctrlKey) return false;
  return mac ? e.key === '[' && e.metaKey && !e.altKey : e.key === 'ArrowLeft' && e.altKey && !e.metaKey;
}

// ---- hints for the buttons and the Back link ---------------------------------------------------------------------------------

/** `title` and `aria-keyshortcuts` of a Back link (spec 3.13). */
export function backHint({ label, mac }) {
  return { title: `Back to ${label} (${mac ? `${CMD}[` : `Alt+${LEFT}`})`, keys: mac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft' };
}

/** `title` and `aria-keyshortcuts` of the Keyboard shortcuts button; with the setting off only Mod+/ is named, because "?" does nothing. */
export function helpHint({ mac, singleKey }) {
  const modKey = mac ? 'Meta+Slash' : 'Control+Slash';
  if (singleKey) return { title: 'Keyboard shortcuts (?)', keys: `Shift+Slash ${modKey}` };
  return { title: `Keyboard shortcuts (${mac ? `${CMD}/` : 'Ctrl+/'})`, keys: modKey };
}

// ---- the window --------------------------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function keysCell(r) {
  return h('td', null, r.keys.map((combo, i) => [i ? r.alt : null, combo.map((k, j) => [j ? '+' : null, h('kbd', { text: k })])]));
}

function section(g) {
  return h('section', { class: 'kbd-sec' },
    h('h3', { text: g.group }),
    h('table', null,
      h('caption', { class: 'sr-only', text: g.group }),
      h('thead', null, h('tr', null, ['Name', 'Shortcut', 'Description'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', null, g.rows.map((r) => h('tr', null, h('td', { text: r.name }), keysCell(r), h('td', { text: r.description }))))));
}

/**
 * Closes the disclosure menus that are open (the dashboard's; the session window has none) the way ui.js closeMenu does, without moving
 * focus. ui.js cannot be imported here: the session page does not load it. Returns the control focus should come back to: `opener`, or
 * the menu's button when `opener` sat inside a menu that is now hidden (a hidden control cannot take focus).
 */
function closeMenus(opener) {
  let back = opener;
  for (const m of document.querySelectorAll('.menu:not([hidden])')) {
    m.hidden = true;
    m.removeAttribute('data-up');
    const btn = m.previousElementSibling;
    btn?.setAttribute('aria-expanded', 'false');
    if (opener && m.contains(opener)) back = btn;
  }
  return back;
}

/**
 * Opens #kbd-dlg (markup in index.html and session.html) for one window and tier, as a modal dialog: the heading gets focus, Esc or
 * Close closes it, and focus goes back to `opener` (or the screen heading when the opener is gone). This function is the only owner
 * of that focus: the markup carries data-own-focus, so ui.js initDialogs does not restore it a second time. An open menu is closed
 * first, so one Esc closes the window. The app tier's footer shows the Single-key switch and a way to Settings; the browser tier's has
 * only Close. Opening it twice does nothing.
 */
export function openShortcuts({ window: win, tier, mac, singleKey, opener }) {
  const dlg = $('kbd-dlg');
  if (!dlg || dlg.open) return;
  const back = closeMenus(opener);
  let leaving = false; // "Change in Settings" navigates; the new screen takes the focus
  const close = h('button', { type: 'button', class: 'btn', text: 'Close', onclick: () => dlg.close() });
  const toSettings = () => {
    leaving = true;
    dlg.close();
    if (win === 'session') location.assign('/#settings');
    else location.hash = '#settings';
  };
  $('kbd-sub').textContent = win === 'session' ? 'Session window' : 'Dashboard';
  $('kbd-body').replaceChildren(...shortcutsFor({ window: win, tier, mac }).map(section));
  $('kbd-foot').replaceChildren(...(tier === 'app'
    ? [h('span', { class: 'muted', text: `Single-key shortcuts: ${singleKey ? 'On' : 'Off'}` }), h('button', { type: 'button', class: 'btn link', text: 'Change in Settings', onclick: toSettings }), h('span', { class: 'sp' }), close]
    : [h('span', { class: 'sp' }), close]));
  dlg.addEventListener('close', () => {
    if (leaving) return;
    let to = back?.isConnected ? back : null;
    if (!to) {
      to = document.querySelector('.screen:not([hidden]) h1') ?? document.querySelector('h1');
      if (to && !to.hasAttribute('tabindex')) to.setAttribute('tabindex', '-1');
    }
    to?.focus();
  }, { once: true });
  dlg.showModal();
  $('kbd-h').focus();
}
