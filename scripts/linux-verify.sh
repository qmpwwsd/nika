#!/usr/bin/env bash
# Linux verification of nika (CI job `linux-verify`, also run locally in Docker: see Dockerfile.test).
# Runs from the repo root on Linux, in a throwaway HOME / config / state / tmux dir, and prints a PASS/FAIL table.
# Exit 0 only when every row is PASS. Needs: node 22, npm, tmux, ps (procps), ss (iproute2), od, timeout.
#   docker build -f Dockerfile.test -t nika-verify . && docker run --rm nika-verify
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "linux-verify: Linux only (this is $(uname -s)). Run it in Docker:" >&2
  echo "  docker build -f Dockerfile.test -t nika-verify . && docker run --rm nika-verify" >&2
  exit 2
fi
for tool in node npm tmux ps ss od timeout mktemp; do
  command -v "$tool" >/dev/null || { echo "linux-verify: missing tool: $tool" >&2; exit 2; }
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Nothing here may touch the real ~/.claude, config, state or tmux server.
WORK="$(mktemp -d)"
LOGS="$WORK/logs"
SOCK=nika-verify
export HOME="$WORK/home" CLAUDE_CONFIG_DIR="$WORK/claude" NIKA_CONFIG_DIR="$WORK/nika-config" \
  XDG_CONFIG_HOME="$WORK/xdg-config" XDG_STATE_HOME="$WORK/state" TMUX_TMPDIR="$WORK/tmux"
mkdir -m 700 "$LOGS" "$HOME" "$CLAUDE_CONFIG_DIR" "$NIKA_CONFIG_DIR" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$TMUX_TMPDIR"
unset TMUX TMUX_PANE NIKA_APP NIKA_NODE NIKA_TMUX NIKA_CLAUDE NIKA_PORT NIKA_BIN NODE_OPTIONS ANTHROPIC_API_KEY
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

tm() { tmux -u -L "$SOCK" -f /dev/null "$@"; }

cleanup() {
  tm kill-server 2>/dev/null || true
  local p
  for p in $(jobs -p); do kill "$p" 2>/dev/null || true; done
  if [[ -d $WORK ]]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

ROWS=()
TAILS=()
TAILED=
FAILED=0
CUR=
add() { # PASS|FAIL label [detail]
  ROWS+=("$1"$'\t'"$2"$'\t'"${3:-}")
  if [[ $1 != PASS ]]; then
    FAILED=1
    if [[ $TAILED != *" $CUR "* ]]; then # one log tail per check
      TAILED+=" $CUR "
      TAILS+=("--- $CUR ---"$'\n'"$(tail -n 30 "$LOGS/$CUR".* 2>/dev/null || true)")
    fi
  fi
}

# Runs JS (stdin) as an ES module from the repo root; it prints "PASS|FAIL<TAB>label<TAB>detail" lines on stdout.
run_js() { # name
  local name=$1 out rc=0 st label detail n=0
  CUR=$name
  out="$(node --input-type=module -e "$(cat)" 2>"$LOGS/$name.err")" || rc=$?
  while IFS=$'\t' read -r st label detail; do
    [[ $st == PASS || $st == FAIL ]] || continue
    add "$st" "$label" "$detail"
    n=$((n + 1))
  done <<<"$out"
  if ((rc != 0)); then add FAIL "$name: script crashed (exit $rc)" "$(tail -n 3 "$LOGS/$name.err" | tr '\n' ' ')"
  elif ((n == 0)); then add FAIL "$name: no result lines" ""; fi
}

JS_REC="const rec = (ok, label, detail = '') => console.log([ok ? 'PASS' : 'FAIL', label, String(detail).replace(/\s+/g, ' ')].join('\t'));"

# ---- a. unit and integration tests --------------------------------------------------------------------------------
check_npm_test() {
  CUR=npm-test
  local rc=0 summary
  timeout 900 npm test >"$LOGS/npm-test.log" 2>&1 || rc=$?
  summary="$(grep -E '^(#|ℹ) (tests|pass|fail|skipped) [0-9]+' "$LOGS/npm-test.log" | sed -E 's/^(#|ℹ) //' | tr '\n' ' ' || true)"
  if ((rc == 0)); then add PASS "a. npm test" "$summary"; else add FAIL "a. npm test (exit $rc)" "$summary"; fi
}

# ---- b. V1: ps lstart on Linux, through the real parser -----------------------------------------------------------
check_ps() {
  sleep 300 &
  local pid=$!
  # TZ is set to a non-UTC zone (POSIX form, needs no tzdata): processTable must still print UTC.
  SLEEP_PID=$pid TZ=JST-9 run_js ps <<JS
import { processTable, isAlive } from './src/collect/registry.js';
import { makeExec } from './src/exec.js';
$JS_REC
const pid = Number(process.env.SLEEP_PID);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const table = await processTable(makeExec());
const raw = table?.get(pid);
const m = typeof raw === 'string' && /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\$/.exec(raw);
rec(Boolean(m), 'b. V1 ps lstart: pid in table, ctime-style start time', raw ?? 'pid not in table');
if (m) {
  const t = Date.UTC(+m[6], MON.indexOf(m[1]), +m[2], +m[3], +m[4], +m[5]);
  const delta = Math.round((Date.now() - t) / 1000);
  rec(Math.abs(delta) < 120, 'b. V1 parsed start time within 2 min of now (process TZ=' + process.env.TZ + ')', 'delta ' + delta + ' s');
  rec(isAlive({ pid, procStart: raw.replace(/ (\d) /, '  \$1 ') }, table), 'b. V1 isAlive accepts ps spacing of the same start time');
  rec(!isAlive({ pid, procStart: 'Mon Jan 1 00:00:00 2001' }, table), 'b. V1 isAlive rejects a different start time (pid reuse)');
}
JS
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# ---- c. serve --app handshake -------------------------------------------------------------------------------------
check_handshake() {
  run_js handshake <<JS
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
$JS_REC
const secret = crypto.randomBytes(32).toString('base64url');
const child = spawn(process.execPath, ['bin/nika', 'serve', '--app'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let err = '';
child.stderr.on('data', (d) => { err += d; });
child.stdin.on('error', () => {});
const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
const ready = new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('no ready line in 10 s: ' + err.trim().slice(0, 200))), 10000);
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { const msg = JSON.parse(line); if (msg.type === 'ready') { clearTimeout(timer); resolve(msg); } } catch { /* not JSON */ }
    }
  });
  exited.then(({ code }) => reject(new Error('exited ' + code + ' before ready: ' + err.trim().slice(0, 200))));
});
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});
const ss = () => new Promise((resolve, reject) => execFile('ss', ['-ltnH'], (e, out) => (e ? reject(e) : resolve(out))));
try {
  child.stdin.write(JSON.stringify({ type: 'hello', proto: 1, secret }) + '\n');
  const msg = await ready;
  const port = msg.port;
  rec(msg.proto === 1 && Number.isInteger(port) && port > 0 && port < 65536, 'c. serve --app: ready line (proto 1, port)', 'port ' + port + ', version ' + msg.version);
  const ok = await get(port, '/api/app/me', { 'X-Nika-App': secret });
  let me = {};
  try { me = JSON.parse(ok.body); } catch { /* checked below */ }
  rec(ok.status === 200 && me.tier === 'app' && me.platform === 'linux', 'c. GET /api/app/me with the secret: 200, tier app, platform linux', ok.status + ' ' + me.tier + ' ' + me.platform + ' tmux=' + me.tmux);
  const noSecret = await get(port, '/api/app/me');
  rec(noSecret.status === 403, 'c. GET /api/app/me without the secret: 403', noSecret.status);
  const wrong = await get(port, '/api/app/me', { 'X-Nika-App': 'x'.repeat(43) });
  rec(wrong.status === 403, 'c. GET /api/app/me with a wrong secret: 403', wrong.status);
  const foreign = await get(port, '/api/app/me', { 'X-Nika-App': secret, Host: 'evil.example' });
  rec(foreign.status === 403, 'c. GET /api/app/me with a foreign Host header: 403', foreign.status);
  const listeners = (await ss()).split('\n').map((l) => l.trim().split(/\s+/)[3]).filter((a) => a && a.endsWith(':' + port));
  rec(listeners.length > 0 && listeners.every((a) => a === '127.0.0.1:' + port), 'c. listener is on 127.0.0.1 only (ss -ltn)', listeners.join(' ') || 'no listener found');
  child.stdin.end();
  const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 5000))]);
  rec(done.code === 0, 'c. closing stdin makes the server exit 0', 'code ' + done.code + (done.sig ? ' signal ' + done.sig : ''));
} catch (e) {
  rec(false, 'c. serve --app handshake', e.message);
} finally {
  child.kill('SIGKILL');
}
JS
}

# ---- d. tmux on a private server: pane output -> mirror, send-keys, bracketed paste ------------------------------
check_tmux() {
  local out="$WORK/pane.out" payload="$WORK/pane.sh" pane
  cat >"$payload" <<'SH'
#!/bin/sh
# SGR colours, then OSC 52, OSC 8 and a DCS sequence, then a raw-mode reader with bracketed paste switched on.
printf '\033[1;31mRED\033[0m \033[38;5;33mBLUE256\033[0m \033[38;2;10;200;30mRGB\033[0m\n'
printf '\033]52;c;aGVsbG8=\007'
printf '\033]8;;http://example.invalid/\033\\LINK\033]8;;\033\\\n'
printf '\033P1$r0m\033\\'
printf 'after\n'
printf '\033[?2004h'
stty raw -echo
exec cat >"$1"
SH
  CUR=tmux
  echo "tmux $(tmux -V)" >"$LOGS/tmux.log"
  if ! pane="$(tm new-session -d -s verify -x 100 -y 30 -P -F '#{pane_id}' -- sh "$payload" "$out" 2>>"$LOGS/tmux.log")"; then
    add FAIL "d. tmux: start a private server and a pane" "see log"
    return
  fi
  PANE="$pane" OUT="$out" SOCK="$SOCK" run_js tmux <<JS
import fs from 'node:fs';
import { createMirror, parseCapture } from './src/mirror.js';
import { createKeys } from './src/keys.js';
import { makeExec } from './src/exec.js';
$JS_REC
const { PANE: pane, OUT: outFile, SOCK: sock } = process.env;
const base = makeExec({ timeout: 5000 });
// nika's own modules, aimed at the private server (-L goes before the tmux subcommand).
const exec = (cmd, args, opts) => base(cmd, ['-L', sock, ...args], opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (await fn()) return true; await sleep(100); } return false; };
const bytes = () => { try { return fs.readFileSync(outFile, 'latin1'); } catch { return null; } };
const show = (s) => JSON.stringify(s);

const shown = await until(async () => (await exec('tmux', ['-u', 'capture-pane', '-p', '-t', pane])).stdout.includes('after') && bytes() !== null);
rec(shown, 'd. tmux: pane printed its output and switched to raw mode', shown ? '' : 'timeout');

const rawCap = (await exec('tmux', ['-u', 'capture-pane', '-p', '-e', '-N', '-t', pane])).stdout;
const mirror = createMirror({ exec, tmuxBin: 'tmux' });
const cap = await mirror.capture(pane);
const spans = (cap.body?.rows ?? []).flat();
const text = spans.map((s) => s.t).join('');
const find = (needle) => spans.find((s) => s.t.includes(needle));
const red = find('RED'); const b256 = find('BLUE256'); const rgb = find('RGB');
rec(cap.status === 200 && red?.s.fg === 1 && red.s.b === true, 'd. mirror keeps SGR bold red', show(red?.s));
rec(b256?.s.fg === 33, 'd. mirror keeps SGR 256-colour', show(b256?.s));
rec(Array.isArray(rgb?.s.fg) && rgb.s.fg.join() === '10,200,30', 'd. mirror keeps SGR truecolour', show(rgb?.s));
const present = 'tmux capture had: OSC52=' + rawCap.includes('\x1b]52') + ' OSC8=' + rawCap.includes('\x1b]8') + ' DCS=' + rawCap.includes('\x1bP');
rec(text.includes('LINK') && text.includes('after') && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)
  && !/aGVsbG8|example\.invalid|1\\\$r/.test(text), 'd. mirror drops OSC and DCS (no control bytes, no payload text)', present);
const synthetic = parseCapture('A\x1b]52;c;aGVsbG8=\x07B\x1bP1\$r0m\x1b\\\\C\x1b]8;;http://example.invalid/\x1b\\\\D\x1b]8;;\x1b\\\\\n', 80).flat().map((s) => s.t).join('');
rec(synthetic === 'ABCD', 'd. mirror drops a raw OSC 52, OSC 8 and DCS string', show(synthetic));

const keys = createKeys({ exec, tmuxBin: 'tmux' });
const expectText = '-x text';
let r = await keys.send(pane, { text: expectText });
const gotText = await until(() => bytes() === expectText);
rec(r.status === 200 && gotText, "d. V3 send-keys -l -- '-x text' arrives literally", 'status ' + r.status + ', got ' + show(bytes()));

const paste = 'first line\nsecond line\n\tthird line';
const expectPaste = '\x1b[200~first line\rsecond line\r\tthird line\x1b[201~';
r = await keys.send(pane, { paste });
const gotPaste = await until(() => bytes() === expectText + expectPaste);
rec(r.status === 200 && gotPaste, 'd. multi-line paste (load-buffer - + paste-buffer -p -d) arrives, bracketed', 'status ' + r.status + ', got ' + show(bytes()?.slice(expectText.length)));
const buffers = (await exec('tmux', ['-u', 'list-buffers'])).stdout.trim();
rec(buffers === '', 'd. paste leaves no tmux buffer behind', show(buffers));

r = await keys.send(pane, { keys: ['Enter'] });
const gotEnter = await until(() => bytes() === expectText + expectPaste + '\r');
rec(r.status === 200 && gotEnter, 'd. named key Enter arrives as CR', 'status ' + r.status);
JS
  tm kill-server 2>/dev/null || true
}

check_cleanup() {
  CUR=cleanup
  local left=()
  cleanup
  if [[ -S $TMUX_TMPDIR/tmux-$(id -u)/$SOCK ]] || tm has-session 2>/dev/null; then left+=("tmux server"); fi
  if [[ -n "$(jobs -p)" ]]; then left+=("background job"); fi
  if [[ -e $WORK ]]; then left+=("temp dir"); fi
  if ((${#left[@]} == 0)); then add PASS "e. cleanup: tmux server, child processes and temp dir are gone"
  else add FAIL "e. cleanup left: ${left[*]}"; fi
}

check_npm_test
check_ps
check_handshake
check_tmux
check_cleanup

printf '\n%-6s  %-84s  %s\n' RESULT CHECK DETAIL
passed=0
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r st label detail <<<"$row"
  printf '%-6s  %-84s  %s\n' "$st" "$label" "$detail"
  if [[ $st == PASS ]]; then passed=$((passed + 1)); fi
done
printf '\n%d of %d checks passed.\n' "$passed" "${#ROWS[@]}"
if ((FAILED)); then
  printf '\nLogs of the failing checks (last lines):\n'
  printf '%s\n' "${TAILS[@]}"
fi
exit "$FAILED"
