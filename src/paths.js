// nika's own config and state directories (XDG base dirs, ADR 0008). Pure functions of env; never a hardcoded user path.
import os from 'node:os';
import path from 'node:path';
import { PROJECT_KEY } from './ids.js';

// XDG Base Directory spec: a relative value is invalid and ignored (it would resolve against the cwd, e.g. a repo).
const abs = (v) => (typeof v === 'string' && path.isAbsolute(v) ? v : undefined);

/** `${NIKA_CONFIG_DIR || XDG_CONFIG_HOME || ~/.config}/nika`; relative values are ignored. */
export function configDir(env = process.env) {
  return path.join(abs(env.NIKA_CONFIG_DIR) || abs(env.XDG_CONFIG_HOME) || path.join(os.homedir(), '.config'), 'nika');
}

/** `${XDG_STATE_HOME || ~/.local/state}/nika`; a relative value is ignored. */
export function stateDir(env = process.env) {
  return path.join(abs(env.XDG_STATE_HOME) || path.join(os.homedir(), '.local', 'state'), 'nika');
}

function checkKey(key) {
  if (!PROJECT_KEY.test(key)) throw Object.assign(new Error('invalid project key'), { code: 'EINVAL' });
  return key;
}

export function projectStateDir(key, env = process.env) {
  return path.join(stateDir(env), 'projects', checkKey(key));
}

/** Where `nika spawn` writes `<name>.session|.md|.rc` and `.last-pane` for a project. */
export function reportsDir(key, env = process.env) {
  return path.join(projectStateDir(key, env), 'reports');
}

/** All backups of `nika rules apply`: one folder per project below it (`nika doctor` prints this). */
export function backupsRoot(env = process.env) {
  return path.join(stateDir(env), 'backups');
}

/** Where `nika rules apply` copies a project's files before overwriting them (never inside the repo, T15); the last 10 are kept. */
export function backupsDir(key, env = process.env) {
  return path.join(backupsRoot(env), checkKey(key));
}
