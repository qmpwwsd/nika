// Cutting Claude's dialog out of the terminal view (nika 0.5.1 item E; design DES-A sections 1.5 and 3, docs/design/spec.md 9.19).
// While nika shows its own panel for what Claude asks (the permission prompt, a question, a review, a plan approval, the feedback survey), the
// mirror ends above Claude's version of it and a strip names what to answer below. This file holds the pure rules: which panel is up
// (panelOf), and the row where the mirror ends for it (cropOf). It has no DOM and makes no request; session.js hands it the cleaned values and the
// capture, and Node tests every rule (test/crop.test.js). Row numbers are the server's display-only `top` fields; they are never part of a sig,
// an identity or a guard, and a missing, odd or out-of-range one only means "no crop" (the whole screen shows, as before).
// Keep this file ASCII: write every symbol as an escape.

/** The strip's text while only the input box is cut (the message box below mirrors it). */
export const INPUT_TEXT = 'Input box \u00b7 mirrored in the message box below';

/** The strip's text for each panel kind (never colour alone: the strip has its own icon and these words). */
export const CROP_TEXT = Object.freeze({
  question: "Claude's question \u00b7 answer it in the form below",
  review: 'Your answers \u00b7 submit them in the form below',
  plan: 'Plan approval \u00b7 the plan is above, answer in the form below',
  prompt: 'Permission prompt \u00b7 answer it in the panel below',
  survey: 'Feedback question \u00b7 answer it in the panel below',
});

const FORM_KINDS = new Set(['question', 'review', 'plan']);

/**
 * Which of nika's own panels is up, or null. `v` is { promptShown, prompt, formShown, formLive, dialog, surveyShown, survey }: what the page has
 * drawn (the *Shown and formLive flags) and the cleaned values it drew from. Checked in this order, and a flag counts only when it is `true`:
 *   1. the permission-prompt panel                      -> { kind: 'prompt', bypass }, bypass when any option is marked bypass (cleanPrompt marks
 *      every option when the window mentions it); a prompt with no options list is taken as bypass, never as safe;
 *   2. the dialog form, live (not terminal mode), with a ready dialog of kind question, review or plan -> { kind, bypass: dialog.bypass === true };
 *   3. the survey panel with a ready (answerable) survey -> { kind: 'survey', bypass: false }.
 * Everything else (an unreadable dialog, the form still reading, a terminal-only survey, a hidden panel) is null: nika's panel cannot answer there.
 */
export function panelOf(v) {
  if (v?.promptShown === true && v.prompt) {
    const options = v.prompt.options;
    return { kind: 'prompt', bypass: !Array.isArray(options) || options.some((o) => o?.bypass === true) };
  }
  if (v?.formShown === true && v.formLive === true && v.dialog?.state === 'ready' && FORM_KINDS.has(v.dialog.at)) {
    return { kind: v.dialog.at, bypass: v.dialog.bypass === true };
  }
  if (v?.surveyShown === true && v.survey?.state === 'ready') return { kind: 'survey', bypass: false };
  return null;
}

/**
 * Where the mirror ends for `panel` (panelOf's answer), as { top, kind }, or null for no crop. `body` is the capture body (rows, prompt, dialog,
 * survey); `passOn` is Type into pane (on shows the whole screen) and `dialogSig` the sig of the dialog the form was drawn for.
 * No crop when: there is no panel, or it carries bypass, or Type into pane is on; the capture's own bypass flag is set (the prompt's, the dialog's);
 * the dialog is not ready, is not of the panel's kind, or its sig is not the form's (a dialog read for another screen); the survey is not ready;
 * or the source's `top` is not a whole number from 1 to the last row (0 would leave an empty view, so the whole screen shows instead).
 */
export function cropOf(body, panel, { passOn = false, dialogSig = null } = {}) {
  if (!panel || panel.bypass === true || passOn) return null;
  const kind = panel.kind;
  let source = null;
  if (kind === 'prompt') {
    if (body?.prompt?.bypass !== true) source = body?.prompt;
  } else if (FORM_KINDS.has(kind)) {
    const d = body?.dialog;
    if (d?.state === 'ready' && d.at === kind && d.bypass !== true && typeof d.sig === 'string' && d.sig !== '' && d.sig === dialogSig) source = d;
  } else if (kind === 'survey') {
    if (body?.survey?.state === 'ready') source = body.survey;
  }
  const top = source?.top;
  const n = Array.isArray(body?.rows) ? body.rows.length : 0;
  return Number.isInteger(top) && top >= 1 && top < n ? { top, kind } : null;
}
