// The reason is one of a fixed list of keys (the shell only ever sends these); anything else falls back to start-failed.
// Text goes in through textContent. No IPC and no Tauri API: Retry is a plain link the shell intercepts.
const TEXT = {
  'node-missing': ['Node.js was not found', 'nika needs Node.js 22 or newer to run its server. Install it (for example with Homebrew: brew install node), then retry.'],
  'start-failed': ['nika could not start', 'The nika server did not start. Run nika doctor in a terminal to see what is wrong, then retry.'],
  stopped: ['nika stopped', 'The nika server stopped unexpectedly. Retry to start it again.'],
};
const reason = new URLSearchParams(location.search).get('reason');
const [title, body] = Object.hasOwn(TEXT, reason) ? TEXT[reason] : TEXT['start-failed'];
document.getElementById('title').textContent = title;
document.getElementById('body').textContent = body;
document.title = `${title} · nika`;
document.getElementById('title').focus();
