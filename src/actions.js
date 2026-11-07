// The only side effects nika has: focusing a tmux pane, and reading a report file it indexed itself.
import { listPanes } from './collect/tmux.js';
import { discoverReportDirs, indexReports } from './collect/reports.js';
import { openRegular, readAt } from './fsafe.js';
import { UUID, PANE_ID } from './ids.js';

export { PANE_ID };
const REPORT_MAX = 256 * 1024;

/** Focus a pane: argv only, pane id validated and checked against the live pane list first. */
export async function focusPane(pane, exec, bin = 'tmux') {
  if (typeof pane !== 'string' || !PANE_ID.test(pane)) return { status: 400, body: { error: 'invalid pane id' } };
  const { panes, error } = await listPanes(exec, bin);
  if (error) return { status: 503, body: { error } };
  if (!panes.has(pane)) return { status: 404, body: { error: 'pane not found' } };
  try {
    // Switch the most recent client to the pane's session; fails harmlessly when no client is attached.
    await exec(bin, ['switch-client', '-t', pane]);
  } catch {
    // no client
  }
  try {
    await exec(bin, ['select-window', '-t', pane]);
    await exec(bin, ['select-pane', '-t', pane]);
  } catch (err) {
    return { status: 500, body: { error: `tmux failed: ${(err.stderr || err.message || '').trim().split('\n')[0]}` } };
  }
  return { status: 200, body: { ok: true, pane } };
}

/**
 * Report text for a session id, looked up in nika's own report index; the request never carries a path.
 * The file is opened without following symlinks and must be a regular file owned by this user (review F1, F2).
 */
export async function readReport(sessionId, config) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return { status: 400, text: 'invalid session id' };
  const index = await indexReports(await discoverReportDirs(config.tmpRoot, config.reportDirs ?? []));
  const entry = index.get(sessionId);
  if (!entry?.reportPath) return { status: 404, text: 'no report for this session' };
  let opened;
  try {
    opened = await openRegular(entry.reportPath);
    const text = await readAt(opened.handle, 0, REPORT_MAX);
    const more = opened.st.size > REPORT_MAX ? `\n\n[… truncated at ${REPORT_MAX / 1024} KB of ${Math.round(opened.st.size / 1024)} KB]` : '';
    return { status: 200, text: text + more };
  } catch {
    return { status: 404, text: 'report file not readable' };
  } finally {
    await opened?.handle.close();
  }
}
