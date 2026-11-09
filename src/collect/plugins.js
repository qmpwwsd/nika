// Installed Claude Code plugins. `listPlugins` returns names only, for the per-project plugin picker: values of
// installed_plugins.json (paths, versions, anything else) are never read there. `listPluginDirs` additionally reads
// each record's `installPath`, and nothing else, for the command collector. No settings, hooks or keys are touched
// (project-rules §4).
import fs from 'node:fs/promises';
import path from 'node:path';
import { openRegular, readAt } from '../fsafe.js';
import { PLUGIN_NAME } from '../ids.js';

const MAX_BYTES = 1024 * 1024;
const MAX_NAMES = 200;
const MAX_RECORDS = 20; // install records looked at per plugin key

/** The `plugins` object of <claudeDir>/plugins/installed_plugins.json; null when missing, unsafe, oversized or not an object. */
async function readInstalled(claudeDir) {
  let opened;
  try {
    opened = await openRegular(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    if (opened.st.size > MAX_BYTES) return null;
    const plugins = JSON.parse(await readAt(opened.handle, 0, opened.st.size))?.plugins;
    return plugins && typeof plugins === 'object' && !Array.isArray(plugins) ? plugins : null;
  } catch {
    return null;
  } finally {
    await opened?.handle.close();
  }
}

const sortedNames = (plugins) => Object.keys(plugins).filter((k) => PLUGIN_NAME.test(k)).sort().slice(0, MAX_NAMES);

/** Sorted `name@marketplace` keys of `plugins` in <claudeDir>/plugins/installed_plugins.json; [] when missing or invalid. */
export async function listPlugins(claudeDir) {
  const plugins = await readInstalled(claudeDir);
  return plugins ? sortedNames(plugins) : [];
}

/**
 * `{ name, installPath }` per installed plugin key, sorted, ≤ 200. installPath comes from the first install record
 * whose `installPath` is an absolute path that resolves (symlinks followed) strictly inside <claudeDir>/plugins/cache,
 * and is returned in its resolved form; a plugin with no such record is left out. No other record field is read.
 */
export async function listPluginDirs(claudeDir) {
  const plugins = await readInstalled(claudeDir);
  if (!plugins) return [];
  let cache;
  try {
    cache = await fs.realpath(path.join(claudeDir, 'plugins', 'cache'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of sortedNames(plugins)) {
    const records = Array.isArray(plugins[name]) ? plugins[name].slice(0, MAX_RECORDS) : [];
    for (const record of records) {
      const p = record?.installPath;
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      try {
        const real = await fs.realpath(p);
        if (!real.startsWith(cache + path.sep)) continue;
        out.push({ name, installPath: real });
        break;
      } catch { /* missing path: try the next record */ }
    }
  }
  return out;
}
