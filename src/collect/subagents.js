// In-process subagents (Agent tool children) of one session:
// <claudeDir>/projects/<slug>/<session-uuid>/subagents/agent-<id>.meta.json (+ agent-<id>.jsonl for activity time).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readHead } from '../fsafe.js';
import { mapLimit } from '../util.js';

const META_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.meta\.json$/;
const META_MAX = 64 * 1024;
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

export async function readSubagents(transcript) {
  const dir = path.join(transcript.dir, path.basename(transcript.path, '.jsonl'), 'subagents');
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
        model: str(meta.model),
        finished: meta.finished === true,
        lastActivity,
      };
    } catch {
      return null; // broken or unsafe meta file
    }
  });
  return out.filter(Boolean);
}
