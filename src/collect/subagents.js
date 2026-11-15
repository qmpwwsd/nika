// In-process subagents (Agent tool children) of one session:
// <claudeDir>/projects/<slug>/<session-uuid>/subagents/agent-<id>.meta.json (+ agent-<id>.jsonl for activity time and, in the app tier, the transcript).
// Every function takes the transcript index entry { path, dir, ... } from indexTranscripts; nothing here takes a value from a request.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readHead, isRealDir } from '../fsafe.js';
import { SUBAGENT_ID, TOOL_USE_ID } from '../ids.js';
import { mapLimit } from '../util.js';

const ID = SUBAGENT_ID.source.slice(1, -1); // the id shape without its anchors: the file-name patterns below are built from SUBAGENT_ID, not from a copy
const META_FILE = new RegExp(`^agent-(${ID})\\.meta\\.json$`);
const TRANSCRIPT_FILE = new RegExp(`^agent-(${ID})\\.jsonl$`);
const META_MAX = 64 * 1024;
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * `<dir>/<session>/subagents` for a session, only when `<dir>/<session>` and `subagents` are both real directories (lstat: a planted symlink
 * is not followed to another folder). Else null.
 */
export async function subagentDir(transcript) {
  const session = path.join(transcript.dir, path.basename(transcript.path, '.jsonl'));
  const dir = path.join(session, 'subagents');
  return (await isRealDir(session)) && (await isRealDir(dir)) ? dir : null;
}

/**
 * agent id → path of its `agent-<id>.jsonl`, from nika's own listing of the session's subagents folder (the name comes from the listing,
 * never from a request). Empty when the folder is missing, unreadable or not real. Names are matched, not opened: opening is fsafe's job.
 */
export async function subagentTranscripts(transcript) {
  const out = new Map();
  const dir = await subagentDir(transcript);
  if (!dir) return out;
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = TRANSCRIPT_FILE.exec(n);
    if (m) out.set(m[1], path.join(dir, n));
  }
  return out;
}

/**
 * The session's subagents from their meta files, read again on every call (a meta gains `finished: true` when the agent's loop stops and loses
 * it when the agent wakes up, so nothing is cached). `toolUseId` is for the server's link between a parent's Agent call and its subagent:
 * a valid id or null, and `model` falls back to pickedEffortModel (Claude Code 2.1.325 writes only that).
 */
export async function readSubagents(transcript) {
  const dir = await subagentDir(transcript);
  if (!dir) return [];
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = await mapLimit(names, 8, async (n) => {
    const m = META_FILE.exec(n);
    if (!m) return null;
    try {
      const meta = JSON.parse(await readHead(path.join(dir, n), META_MAX));
      if (!meta || typeof meta !== 'object') return null;
      let lastActivity = null;
      try {
        const st = await fs.lstat(path.join(dir, `agent-${m[1]}.jsonl`));
        if (st.isFile()) lastActivity = st.mtimeMs;
      } catch {
        // no transcript yet
      }
      return {
        id: m[1],
        type: str(meta.agentType),
        description: str(meta.description),
        model: str(meta.model) ?? str(meta.pickedEffortModel),
        toolUseId: typeof meta.toolUseId === 'string' && TOOL_USE_ID.test(meta.toolUseId) ? meta.toolUseId : null,
        finished: meta.finished === true,
        lastActivity,
      };
    } catch {
      return null; // broken or unsafe meta file
    }
  });
  return out.filter(Boolean);
}
