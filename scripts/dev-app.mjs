#!/usr/bin/env node
// DEV ONLY (not shipped: package.json "files" excludes scripts/). Starts `nika serve --app` the way the desktop shell
// does (hello + secret over stdin) and prints the URL and the init snippet a test browser needs, e.g. Playwright:
//   await page.addInitScript(({ secret, port }) => { window.__NIKA_APP__ = { secret, port }; }, { secret, port });
// The real shell never prints the secret; this script does so on purpose, to its own terminal only.
// Usage: node scripts/dev-app.mjs   (set NIKA_CONFIG_DIR / XDG_STATE_HOME to use throwaway config and state dirs)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nika');
const secret = crypto.randomBytes(32).toString('base64url');
const child = spawn(process.execPath, [bin, 'serve', '--app'], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'ready') {
      process.stdout.write(`url     http://127.0.0.1:${msg.port}/\nsecret  ${secret}\nport    ${msg.port}\n`);
      process.stdout.write(`init    window.__NIKA_APP__ = { secret: '${secret}', port: ${msg.port} }\n`);
    } else if (msg.type === 'pick-folder') {
      // no native picker here: answer "cancelled"; add projects with `nika projects add <dir>` instead
      child.stdin.write(`${JSON.stringify({ type: 'folder', reqId: msg.reqId, path: null })}\n`);
    } else if (msg.type === 'error') {
      process.stderr.write(`nika: ${msg.message}\n`);
    }
  }
});
child.stdin.write(`${JSON.stringify({ type: 'hello', proto: 1, secret })}\n`);
const stop = () => child.stdin.end();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 1));
