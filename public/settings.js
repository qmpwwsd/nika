// App tier only: the Settings screen, the defaults for every project. One form, one Save: PUT /api/app/settings with the whole
// editable shape (formValue). Values come from GET /api/app/settings, local rules templates from /api/app/templates (names only).
// Per-project choices (plugins) are saved on the project page, never here. The Save bar shows only while the form differs from the
// saved state. Every server string is rendered through h() (textContent).
import { appFetch, applyTheme } from './api.js';
import { h, icon } from './dom.js';
import { $, $$, state, hooks, RX, toast, announce, errText, fieldError, setBusy, syncRadioCards } from './ui.js';
import { CUSTOM, MODEL_ID, MODEL_HINT, fillModelSelect } from './models-ui.js';
import { loadSettings, loadModels } from './project.js';
import { compactPreview } from './ctx.js';
import { render } from './app.js';

let templates = [];
let snapshot = ''; // JSON of formValue() as last populated or saved: the form has unsaved changes when it differs
let wired = false;

const ROLES = ['orchestrator', 'reasoner', 'builder', 'scout'];
const roleSel = (r) => $(`#set-model-${r}`);
const roleCustom = (r) => $(`#set-model-${r}-custom`);

const PCT_MSG = 'Choose a whole number from 20 to 95.';
const DEFAULT_COMPACT = { enabled: true, pct: 80, window: 400000 };

const form = () => $('#set-form');
const radio = (name) => $(`input[name="${name}"]:checked`, form())?.value;
const setRadio = (name, value) => {
  for (const r of $$(`input[name="${name}"]`, form())) r.checked = r.value === value;
};

function clearErrors() {
  for (const i of $$('[aria-invalid="true"]', form())) fieldError(i, '');
  compactError('');
  $('#set-sum').hidden = true;
}

// ---- Auto-compact (design 0.4 section 5) ----

/** The window select as the server stores it: a number, or 'model'. */
const compactWindow = () => {
  const v = $('#set-compact-win').value;
  return v === 'model' ? v : Number(v);
};

/** Whether the number is a whole number from 20 to 95 (blank and fractions are not). */
function compactPctOk() {
  const v = String($('#set-compact-pct').value).trim();
  const n = Number(v);
  return v !== '' && Number.isInteger(n) && n >= 20 && n <= 95;
}

/** The number's error line (its id is set-compact-err, not <input id>-err, so fieldError() does not fit). */
function compactError(msg) {
  $('#set-compact-pct').setAttribute('aria-invalid', msg ? 'true' : 'false');
  const err = $('#set-compact-err');
  err.textContent = msg;
  err.hidden = !msg;
}

/**
 * Brings the Auto-compact row in line with its three controls: Off disables the number, its stepper and the window (values kept)
 * and puts the saved number back when it was invalid; the chip shows icon, word and colour; the result line is redrawn (hidden
 * while the number is invalid); a shown error goes once the number is valid or the row is off.
 */
function syncCompact() {
  const on = $('#set-compact').checked;
  const pct = $('#set-compact-pct');
  if (!on && !compactPctOk()) pct.value = (state.settings?.compaction ?? DEFAULT_COMPACT).pct;
  if (!$('#set-compact-err').hidden && (!on || compactPctOk())) compactError('');
  pct.disabled = !on;
  $('#set-compact-win').disabled = !on;
  for (const b of $$('[data-step-for="set-compact-pct"]', form())) b.disabled = !on;
  const chip = $('#set-compact-st');
  chip.dataset.on = String(on);
  chip.replaceChildren(icon(on ? 'compact' : 'compact-off'), h('span', { text: on ? 'On' : 'Off' }));
  const line = compactPreview({ enabled: on, pct: Number(pct.value), window: compactWindow() });
  const result = $('#set-compact-result');
  result.textContent = line ?? '';
  result.hidden = line === null;
}

function renderTemplates(current) {
  const names = current && !templates.includes(current) ? [...templates, current] : templates;
  $('#set-tpl').replaceChildren(
    h('option', { value: '', text: 'Built-in template' }),
    ...names.map((n) => h('option', { value: n, text: templates.includes(n) ? `${n} (local copy)` : `${n} (not found)` })));
  $('#set-tpl').value = current ?? '';
}

/** Each role is a select (catalog, then Custom ID); a saved value outside the catalog opens as Custom ID with its field filled. */
function fillRoles(models) {
  for (const r of ROLES) {
    const value = models?.[r] ?? '';
    const custom = fillModelSelect(roleSel(r), state.models, value);
    roleCustom(r).value = custom ? value : '';
    roleCustom(r).hidden = !custom;
  }
}

function roleValue(r) {
  return roleSel(r).value === CUSTOM ? roleCustom(r).value.trim() : roleSel(r).value;
}

/** The editable shape, exactly what Save sends. */
function formValue() {
  return {
    models: Object.fromEntries(ROLES.map((role) => [role, roleValue(role)])),
    remoteControl: { enabled: $('#set-rc').checked, prefix: $('#set-rc-prefix').value.trim() },
    permissionMode: radio('perm'),
    panePlacement: radio('place'),
    limits: { maxAgents: Number($('#set-max').value) },
    rules: { localTemplate: $('#set-tpl').value || null },
    ui: { theme: radio('theme'), singleKeyShortcuts: $('#set-singlekey').checked },
    compaction: { enabled: $('#set-compact').checked, pct: Number($('#set-compact-pct').value), window: compactWindow() },
  };
}

/** The Save bar is shown exactly while the form differs from the saved state (a change that is changed back hides it again). */
function syncBar() {
  const bar = $('#set-bar');
  const was = bar.hidden;
  bar.hidden = JSON.stringify(formValue()) === snapshot;
  if (was && !bar.hidden) announce('Unsaved changes. Save or discard them at the bottom.');
}

function populate() {
  const s = state.settings;
  if (!s) return;
  setRadio('theme', s.ui?.theme ?? 'system');
  $('#set-singlekey').checked = s.ui?.singleKeyShortcuts !== false;
  fillRoles(s.models);
  $('#set-rc').checked = Boolean(s.remoteControl?.enabled);
  $('#set-rc-prefix').value = s.remoteControl?.prefix ?? '';
  $('#set-rc-prefix').disabled = !$('#set-rc').checked;
  setRadio('perm', s.permissionMode);
  setRadio('place', s.panePlacement);
  $('#set-max').value = s.limits?.maxAgents ?? 3;
  renderTemplates(s.rules?.localTemplate ?? null);
  const c = s.compaction ?? DEFAULT_COMPACT;
  $('#set-compact').checked = c.enabled !== false;
  $('#set-compact-pct').value = c.pct;
  $('#set-compact-win').value = String(c.window);
  syncRadioCards(form());
  clearErrors();
  syncCompact();
  snapshot = JSON.stringify(formValue());
  $('#set-bar').hidden = true;
}

/** Fields that fail their format check, each with its message shown. */
function validate() {
  const bad = [];
  for (const input of $$('[data-rx]', form())) {
    if (input.disabled) continue;
    const [re, msg] = RX[input.dataset.rx];
    const ok = re.test(input.value.trim()) && (input.dataset.rx === 'prefix' || input.value.trim() !== '');
    fieldError(input, ok ? '' : msg);
    if (!ok) bad.push(input);
  }
  for (const r of ROLES) {
    const input = roleCustom(r);
    const invalid = !input.hidden && !MODEL_ID.test(input.value.trim());
    fieldError(input, invalid ? MODEL_HINT : '');
    if (invalid) bad.push(input);
  }
  const max = $('#set-max');
  const n = Number(max.value);
  const okMax = max.value.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 8;
  fieldError(max, okMax ? '' : 'Choose a whole number from 1 to 8.');
  if (!okMax) bad.push(max);
  const okPct = !$('#set-compact').checked || compactPctOk();
  compactError(okPct ? '' : PCT_MSG);
  if (!okPct) bad.push($('#set-compact-pct'));
  return bad;
}

function summary(text) {
  $('#set-sum-text').textContent = text;
  $('#set-sum').hidden = !text;
}

async function save(e) {
  e.preventDefault();
  if ($('#set-bar').hidden) return; // nothing changed: Enter and Mod+Enter send nothing
  const bad = validate();
  if (bad.length) {
    summary(`${bad.length} field${bad.length === 1 ? ' needs' : 's need'} a fix before saving. Each one is marked below.`);
    bad[0].focus();
    return;
  }
  summary('');
  const btn = $('#set-save');
  setBusy(btn, true, 'Saving…');
  $('#set-discard').disabled = true;
  let r = null;
  try {
    r = await appFetch('/api/app/settings', { method: 'PUT', json: formValue() });
  } catch {
    // handled below as "could not reach"
  }
  setBusy(btn, false);
  $('#set-discard').disabled = false;
  if (r?.status === 200) {
    state.settings = r.body;
    applyTheme(r.body.ui?.theme);
    populate();
    render(true);
    toast('Settings saved');
    $('#set-h').focus();
    return;
  }
  summary(r ? errText(r) : 'Could not reach the nika server.');
  $('#set-sum').focus();
}

function wire() {
  wired = true;
  const f = form();
  f.addEventListener('input', () => {
    syncCompact();
    syncBar();
  });
  f.addEventListener('change', () => {
    syncRadioCards(f);
    $('#set-rc-prefix').disabled = !$('#set-rc').checked;
    syncCompact();
    syncBar();
  });
  $('#set-compact-pct').addEventListener('blur', () => compactError($('#set-compact').checked && !compactPctOk() ? PCT_MSG : ''));
  f.addEventListener('submit', save);
  $('#set-discard').addEventListener('click', () => {
    populate();
    $('#set-h').focus(); // the button that held focus is hidden now
    announce('Changes discarded.');
  });
  for (const r of ROLES) {
    roleSel(r).addEventListener('change', () => { // Custom ID shows its field; any other choice hides it and drops its error
      roleCustom(r).hidden = roleSel(r).value !== CUSTOM;
      fieldError(roleCustom(r), '');
    });
    roleCustom(r).addEventListener('blur', () => {
      if (!roleCustom(r).hidden) fieldError(roleCustom(r), MODEL_ID.test(roleCustom(r).value.trim()) ? '' : MODEL_HINT);
    });
  }
  for (const input of $$('[data-rx]', f)) {
    input.addEventListener('blur', () => {
      if (input.disabled) return;
      const [re, msg] = RX[input.dataset.rx];
      fieldError(input, re.test(input.value.trim()) && (input.dataset.rx === 'prefix' || input.value.trim() !== '') ? '' : msg);
    });
  }
  for (const b of $$('[data-step]', f)) {
    b.addEventListener('click', () => { // data-step-for names the number (default set-max); its own min and max are the clamp
      const i = $(`#${b.getAttribute('data-step-for') || 'set-max'}`);
      const lo = Number(i.min);
      i.value = Math.min(Number(i.max), Math.max(lo, (Math.round(Number(i.value)) || lo) + Number(b.dataset.step)));
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  for (const a of $$('[data-jump]', f)) {
    a.addEventListener('click', (e) => {
      e.preventDefault(); // the link only scrolls; it must not change the route
      const sec = document.getElementById(a.dataset.jump);
      sec.scrollIntoView({ block: 'start' });
      const head = $('h2', sec);
      head.tabIndex = -1;
      head.focus({ preventScroll: true });
    });
  }
}

hooks.enterSettings = async () => {
  if (!wired) wire();
  if (!state.settings) await loadSettings().catch(() => null);
  if (!state.models) await loadModels().catch(() => null); // the first load may have failed; without a catalog only Custom ID is offered
  if (!state.settings) {
    summary('Settings could not be loaded. Check that nika is still running, then open Settings again.');
    return;
  }
  const tp = await appFetch('/api/app/templates').catch(() => null);
  templates = tp?.status === 200 ? tp.body.templates ?? [] : [];
  if ($('#set-bar').hidden) populate();
  else renderTemplates($('#set-tpl').value || null); // unsaved edits stay; only the list of templates is refreshed
};
