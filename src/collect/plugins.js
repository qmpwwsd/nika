// Installed Claude Code plugin names, for the per-project plugin picker. Names only: values of installed_plugins.json
// (paths, versions, anything else) are never read, and no settings, hooks or keys are touched (project-rules §4).
import path from 'node:path';
import { openRegular, readAt } from '../fsafe.js';
import { PLUGIN_NAME } from '../ids.js';

const MAX_BYTES = 1024 * 1024;
const MAX_NAMES = 200;

/** Sorted `name@marketplace` keys of `plugins` in <claudeDir>/plugins/installed_plugins.json; [] when missing or invalid. */
export async function listPlugins(claudeDir) {
  let opened;
  try {
    opened = await openRegular(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    if (opened.st.size > MAX_BYTES) return [];
    const plugins = JSON.parse(await readAt(opened.handle, 0, opened.st.size))?.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
    return Object.keys(plugins).filter((k) => PLUGIN_NAME.test(k)).sort().slice(0, MAX_NAMES);
  } catch {
    return [];
  } finally {
    await opened?.handle.close();
  }
}
