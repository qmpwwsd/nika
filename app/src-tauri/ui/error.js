// The reason is one of a fixed list of keys (the shell only ever sends these); anything else falls back to start-failed.
// Text goes in through textContent. No IPC and no Tauri API: Retry is a plain link the shell intercepts.
// The Node.js version (reason node-old) is shown only when the `node` query value has exactly this form.
const NODE_VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const params = new URLSearchParams(location.search);
const found = params.get('node');
const old = NODE_VERSION.test(found) ? `Node.js ${found}` : 'an old Node.js';
const TEXT = {
  'node-missing': ['Node.js was not found', 'nika needs Node.js 22 or newer to run its server. Install it (for example with Homebrew: brew install node), then retry.'],
  'node-old': ['Node.js is too old', `nika found ${old}, but needs 22 or newer. Install a newer Node.js (for example with Homebrew: brew upgrade node, or a version manager such as nvm), then retry.`],
  'start-failed': ['nika could not start', 'The nika server did not start. Run nika doctor in a terminal to see what is wrong, then retry.'],
  stopped: ['nika stopped', 'The nika server stopped unexpectedly. Retry to start it again.'],
};
const reason = params.get('reason');
const [title, body] = Object.hasOwn(TEXT, reason) ? TEXT[reason] : TEXT['start-failed'];
document.getElementById('title').textContent = title;
document.getElementById('body').textContent = body;
document.title = `${title} · nika`;
document.getElementById('title').focus();
