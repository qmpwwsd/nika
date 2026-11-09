// App tier only: the Settings screen. One form, one Save: PUT /api/app/settings with the whole editable shape.
// Values come from GET /api/app/settings, installed plugins from /api/app/plugins, local rules templates from
// /api/app/templates (names only). Every server string is rendered through h() (textContent).
import { appFetch, applyTheme } from './api.js';
import { h } from './dom.js';
import { $, $$, state, hooks, RX, toast, errText, fieldError, syncRadioCards } from './ui.js';
import { CUSTOM, MODEL_ID, MODEL_HINT, fillModelSelect } from './models-ui.js';
import { loadSettings, loadModels } from './project.js';
import { render } from './app.js';

let installed = [];
let templates = [];
let work = { perProject: {} }; // working copy of plugins.perProject (the PUT replaces the whole map)
let dirty = false;
let wired = false;

const ROLES = ['orchestrator', 'reasoner', 'builder', 'scout'];
const roleSel = (r) => $(`#set-model-${r}`);
const roleCustom = (r) => $(`#set-model-${r}-custom`);

const form = () => $('#set-form');
const radio = (name) => $(`input[name="${name}"]:checked`, form())?.value;
const setRadio = (name, value) => {
  for (const r of $$(`input[name="${name}"]`, form())) r.checked = r.value === value;
};

function markDirty() {
  dirty = true;
  $('#set-bar').hidden = false;
}

function clearErrors() {
  for (const i of $$('[aria-invalid="true"]', form())) fieldError(i, '');
  $('#set-sum').hidden = true;
}

function pluginProject() {
  return $('#set-plug-proj').value;
}

function renderPlugins() {
  const key = pluginProject();
  const picked = work.perProject[key] ?? [];
  const names = [...new Set([...installed, ...picked])].sort();
  const box = $('#set-plugs');
  if (!key) {
    box.replaceChildren(h('p', { class: 'help', text: 'Add a project first.' }));
    $('#set-plug-legend').textContent = 'Plugins';
    return;
  }
  const proj = state.projects?.find((p) => p.key === key);
  $('#set-plug-legend').textContent = `Plugins for ${proj?.name ?? 'this project'} (${picked.length} of ${installed.length} on)`;
  box.replaceChildren(...(names.length ? names.map((n, i) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox', id: `pl-${i}`, value: n, checked: picked.includes(n),
      onchange: () => {
        const on = $$('input:checked', box).map((c) => c.value);
        if (on.length) work.perProject[key] = on;
        else delete work.perProject[key]; // nothing ticked = nika leaves enabledPlugins alone
        markDirty();
        renderPlugins();
        $$('input', box).find((x) => x.value === n)?.focus();
      },
    }), installed.includes(n) ? n : `${n} (not installed)`)) : [h('p', { class: 'help', text: 'No plugins are installed in Claude Code.' })]));
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

function populate() {
  const s = state.settings;
  if (!s) return;
  setRadio('theme', s.ui?.theme ?? 'system');
  fillRoles(s.models);
  $('#set-rc').checked = Boolean(s.remoteControl?.enabled);
  $('#set-rc-prefix').value = s.remoteControl?.prefix ?? '';
  $('#set-rc-prefix').disabled = !$('#set-rc').checked;
  setRadio('perm', s.permissionMode);
  setRadio('place', s.panePlacement);
  $('#set-max').value = s.limits?.maxAgents ?? 3;
  work = { perProject: JSON.parse(JSON.stringify(s.plugins?.perProject ?? {})) };
  const projects = state.projects ?? [];
  const want = projects.some((p) => p.key === state.pluginProject) ? state.pluginProject : projects[0]?.key;
  $('#set-plug-proj').replaceChildren(...projects.map((p) => h('option', { value: p.key, text: p.name })));
  $('#set-plug-proj').value = want ?? '';
  $('#set-plug-proj').disabled = !projects.length;
  renderPlugins();
  renderTemplates(s.rules?.localTemplate ?? null);
  syncRadioCards(form());
  clearErrors();
  $('#set-bar').hidden = true;
  dirty = false;
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
  return bad;
}

function summary(text) {
  $('#set-sum-text').textContent = text;
  $('#set-sum').hidden = !text;
}

async function save(e) {
  e.preventDefault();
  const bad = validate();
  if (bad.length) {
    summary(`${bad.length} field${bad.length === 1 ? ' needs' : 's need'} a fix before saving. Each one is marked below.`);
    bad[0].focus();
    return;
  }
  summary('');
  const btn = $('#set-save');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  let r = null;
  try {
    r = await appFetch('/api/app/settings', {
      method: 'PUT',
      json: {
        models: Object.fromEntries(ROLES.map((r) => [r, roleValue(r)])),
        remoteControl: { enabled: $('#set-rc').checked, prefix: $('#set-rc-prefix').value.trim() },
        permissionMode: radio('perm'),
        panePlacement: radio('place'),
        limits: { maxAgents: Number($('#set-max').value) },
        plugins: { perProject: work.perProject },
        rules: { localTemplate: $('#set-tpl').value || null },
        ui: { theme: radio('theme') },
      },
    });
  } catch {
    // handled below as "could not reach"
  }
  btn.disabled = false;
  btn.removeAttribute('aria-busy');
  if (r?.status === 200) {
    state.settings = r.body;
    applyTheme(r.body.ui?.theme);
    populate();
    render(true);
    toast('Settings saved');
    return;
  }
  summary(r ? errText(r) : 'Could not reach the nika server.');
  $('#set-sum').focus();
}

function wire() {
  wired = true;
  const f = form();
  f.addEventListener('input', markDirty);
  f.addEventListener('change', () => {
    syncRadioCards(f);
    $('#set-rc-prefix').disabled = !$('#set-rc').checked;
  });
  f.addEventListener('submit', save);
  $('#set-discard').addEventListener('click', () => populate());
  $('#set-plug-proj').addEventListener('change', renderPlugins);
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
    b.addEventListener('click', () => {
      const i = $('#set-max');
      i.value = Math.min(8, Math.max(1, (Number(i.value) || 1) + Number(b.dataset.step)));
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
  const [pl, tp] = await Promise.all([appFetch('/api/app/plugins'), appFetch('/api/app/templates')].map((p) => p.catch(() => null)));
  installed = pl?.status === 200 ? pl.body.plugins ?? [] : [];
  templates = tp?.status === 200 ? tp.body.templates ?? [] : [];
  if (dirty) {
    renderPlugins();
    renderTemplates($('#set-tpl').value || null);
  } else {
    populate();
  }
};
