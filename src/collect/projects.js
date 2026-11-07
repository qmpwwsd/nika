// Groups a cwd under its git repository. Linked worktrees fold under the main repository and keep a worktree tag.
// Reads .git (dir or "gitdir:" file) and the worktree's commondir file; never runs git. A cwd that no longer exists
// (ended session in a deleted worktree) still climbs to the nearest existing repository (review F6).
import fs from 'node:fs';
import path from 'node:path';
import { readHeadSync } from '../fsafe.js';

const UNKNOWN = { key: '(unknown)', label: '(unknown)', root: null, worktree: null };
const GIT_FILE_MAX = 4096;

function stat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Value of the "gitdir:" line, without a regex (a padded line made the old one quadratic, review F12). */
function gitdirOf(content) {
  const line = content.split('\n').find((l) => l.startsWith('gitdir:'));
  const v = line?.slice('gitdir:'.length).trim();
  return v || null;
}

function fromGitFile(dir, gitFile) {
  const content = readHeadSync(gitFile, GIT_FILE_MAX);
  const rel = content === null ? null : gitdirOf(content);
  if (!rel) return null;
  const gitdir = path.resolve(dir, rel);
  const common = readHeadSync(path.join(gitdir, 'commondir'), GIT_FILE_MAX)?.trim();
  // No commondir: a submodule or a plain gitdir file. The working dir is the repository (review F11).
  if (!common) return { key: dir, label: path.basename(dir), root: dir, worktree: null };
  const commonDir = path.resolve(gitdir, common);
  const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  if (root === dir) return { key: root, label: path.basename(root), root, worktree: null };
  return { key: root, label: path.basename(root), root, worktree: path.basename(dir) };
}

/** Worktree name of a deleted Claude Code worktree path: <repo>/.claude/worktrees/<name>[/…]. */
function claudeWorktreeName(start, root) {
  const rel = path.relative(root, start).split(path.sep);
  return rel[0] === '.claude' && rel[1] === 'worktrees' && rel[2] ? rel[2] : null;
}

export function resolveProject(cwd, cache) {
  if (typeof cwd !== 'string' || cwd.length === 0) return UNKNOWN;
  if (cache?.has(cwd)) return cache.get(cwd);
  const start = path.resolve(cwd);
  const exists = Boolean(stat(start));
  let result = null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    const git = path.join(dir, '.git');
    const st = stat(git);
    if (st?.isDirectory()) {
      result = { key: dir, label: path.basename(dir), root: dir, worktree: null };
      break;
    }
    if (st?.isFile()) {
      result = fromGitFile(dir, git);
      if (result) break;
    }
    if (path.dirname(dir) === dir) break;
  }
  if (result && !exists && !result.worktree) result = { ...result, worktree: claudeWorktreeName(start, result.root) };
  result ??= { key: start, label: path.basename(start) || start, root: start, worktree: null };
  cache?.set(cwd, result);
  return result;
}
