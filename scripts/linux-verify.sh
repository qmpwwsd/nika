#!/usr/bin/env bash
# Linux verification of nika (CI job `linux-verify`, also run locally in Docker: see Dockerfile.test).
# Runs from the repo root on Linux, in a throwaway HOME / config / state / tmux dir, and prints a PASS/FAIL table.
# Checks: npm test, ps lstart, the serve --app handshake, the tmux mirror and keys, and the session window's fit (zoom, resize, restore).
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

# kill-server returns before the server has exited, and a client started in that moment reaches the dying server and stops
# with "server exited unexpectedly" (seen on CI when check_fit started right after check_tmux). Wait until the server's
# process is gone (at most 5 s) before the next check uses the socket again.
tm_stop() {
  local pid i
  pid="$(tm display-message -p '#{pid}' 2>/dev/null)" || pid=
  tm kill-server 2>/dev/null || true
  [[ $pid =~ ^[0-9]+$ ]] || return 0
  for ((i = 0; i < 50; i++)); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.1; done
}

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
  tm_stop
}

# ---- e. the session window's fit on this machine's tmux (0.5, W7): zoom, resize, and the exact way back ------------
# Drives src/fit.js against the private server: a 3-pane window (fitted by a bigger panel, then given back), a single pane
# (resized smaller, then given back), and the two tmux calls the restore leans on (S10 Q7: tmux 3.2 is the floor).
# F4 (0.5): and two checks with a terminal. A control-mode client (`tmux -C attach`, stdin held open by a pipe, like iTerm2's tmux integration)
# counts as a terminal in #{window_active_clients}: (a) it shows the 3-pane window -> nika zooms it and never resizes it (state terminal);
# (b) it attaches to a window nika resized -> within 2.5 s nika has given the size back, and the restore (R9) logs no difference.
# F9 (0.5): and two checks with the page's focus. With a control-mode client attached, `focus: true` makes nika resize the window to the panel anyway
# (a: one pane; b: three panes, the pane stays zoomed), and `focus: false` gives the size back in place: the lease, the tag and the zoom stay.
# F15 (0.5, owner decision 2026-11-16, resize while zoomed): and one check on a window of its own, with no terminal. Any pane may be squeezed while the page has focus: a plain shell,
# an agent-tagged pane running node and the mirrored pane share a 100x29 window; focus true with a smaller panel (60x20) sizes the window to the panel and keeps the zoom,
# and focus false gives the window its size, layout and zoom back exactly (select-layout, then the zoom again), three times over; the release puts back what was there before.
check_fit() {
  local hold=(node -e 'setInterval(()=>{},1e9)') pa p3 p1 w3 w1 pa15 p15 pb15 w15
  CUR=fit
  echo "tmux $(tmux -V)" >"$LOGS/fit.log"
  # every mirrored pane runs `node`, which nika's pane test takes for claude; the 3-pane window is 100x29: two `sleep` panes on the left, the mirrored one on the right
  if ! pa="$(tm new-session -d -s fit3 -x 100 -y 29 -P -F '#{pane_id}' -- sleep 300 2>>"$LOGS/fit.log")" \
    || ! p3="$(tm split-window -d -h -t "$pa" -P -F '#{pane_id}' -- "${hold[@]}" 2>>"$LOGS/fit.log")" \
    || ! tm split-window -d -v -t "$pa" -- sleep 300 2>>"$LOGS/fit.log" \
    || ! p1="$(tm new-session -d -s fit1 -x 80 -y 24 -P -F '#{pane_id}' -- "${hold[@]}" 2>>"$LOGS/fit.log")"; then
    add FAIL "e. fit: start the private server and its panes" "see log"
    return
  fi
  # F15a: a plain shell (left, top), an agent-tagged pane running node (left, bottom) and the mirrored pane running node (right), 100x29
  if ! pa15="$(tm new-session -d -s fit15 -x 100 -y 29 -P -F '#{pane_id}' -- sh 2>>"$LOGS/fit.log")" \
    || ! p15="$(tm split-window -d -h -t "$pa15" -P -F '#{pane_id}' -- "${hold[@]}" 2>>"$LOGS/fit.log")" \
    || ! pb15="$(tm split-window -d -v -t "$pa15" -P -F '#{pane_id}' -- "${hold[@]}" 2>>"$LOGS/fit.log")" \
    || ! tm set-option -p -t "$pb15" @nika-role agent 2>>"$LOGS/fit.log"; then
    add FAIL "e. fit F15a: start its window and its three panes" "see log"
    return
  fi
  w3="$(tm display-message -p -t "$p3" '#{window_id}')"
  w1="$(tm display-message -p -t "$p1" '#{window_id}')"
  w15="$(tm display-message -p -t "$p15" '#{window_id}')"
  mkdir -m 700 "$WORK/fitstate"
  P3="$p3" W3="$w3" P1="$p1" W1="$w1" P15="$p15" W15="$w15" PB15="$pb15" S3=fit3 S1=fit1 SOCK="$SOCK" STATE="$WORK/fitstate" run_js fit <<JS
import { spawn } from 'node:child_process';
import { createFit } from './src/fit.js';
import { makeExec } from './src/exec.js';
$JS_REC
const { P3: p3, W3: w3, P1: p1, W1: w1, P15: p15, W15: w15, PB15: pb15, S3: sess3, S1: sess1, SOCK: sock, STATE: state } = process.env;
const base = makeExec({ timeout: 5000 });
const exec = (cmd, args, opts) => base(cmd, ['-L', sock, ...args], opts);
const tmux = async (...a) => (await exec('tmux', ['-u', ...a])).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (await fn()) return true; await sleep(100); } return false; };
const show = (s) => JSON.stringify(s);
// tmux 3.8 writes the active and last pane into the layout string (focus history, not geometry); nika strips them before it applies a layout
const strip = (s) => s.replace(/,"(a|l)":(true|\d+)/g, '');
const snap = async (w) => ({
  window: await tmux('display-message', '-p', '-t', w, '-F', '#{window_width}x#{window_height} zoomed=#{window_zoomed_flag} panes=#{window_panes} tag=[#{@nika-fit}]'),
  layout: strip(await tmux('display-message', '-p', '-t', w, '-F', '#{window_layout}')),
  option: await tmux('show-options', '-w', '-t', w, 'window-size'),
  panes: (await tmux('list-panes', '-t', w, '-F', '#{pane_id}=#{pane_width}x#{pane_height}:#{pane_active}')).replace(/\n/g, ' '),
});
const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => k + ': ' + show(a[k]) + ' -> ' + show(b[k])).join('; ').slice(0, 400);
const sized = async (p) => tmux('display-message', '-p', '-t', p, '-F', '#{pane_width}x#{pane_height}');

const ready = await until(async () => (await tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_current_command}')).split('\n').filter((l) => / node\$/.test(l)).length === 4);
rec(ready, 'e. fit: panes run node (the pane test accepts it as claude)', ready ? '' : 'timeout');
const logs = []; // the fit's own log lines (a stderr line as before); F4 looks for a restore that "differs"
const fit = createFit({ exec, tmuxBin: 'tmux', stateDir: state, log: (m) => { logs.push(m); console.error(m); } });

// L1: three panes, panel 120x40 bigger than the window -> fitted, pane 120x40; give back -> the window is as it was
const before3 = await snap(w3);
const put3 = await fit.hold(p3, { cols: 120, rows: 40, open: true });
const during3 = await snap(w3);
rec(put3.status === 200 && put3.body.fit.state === 'fitted' && (await sized(p3)) === '120x40' && during3.window.includes('zoomed=1'),
  'e. fit L1: 3 panes, panel 120x40 -> fitted, mirrored pane 120x40, window zoomed', show(put3.body) + ' ' + (await sized(p3)) + ' ' + during3.window);
const del3 = await fit.release(p3);
const after3 = await snap(w3);
rec(del3.body.released === true && diff(before3, after3) === '', 'e. fit L1: release gives back layout, size, window-size option, focus and tag exactly', diff(before3, after3) || show(del3.body));

// L3: one pane 80x24, panel 60x15 -> resized to 60x15 (nothing to squeeze); give back -> 80x24
const before1 = await snap(w1);
const put1 = await fit.hold(p1, { cols: 60, rows: 15, open: true });
rec(put1.status === 200 && put1.body.fit.state === 'fitted' && (await sized(p1)) === '60x15', 'e. fit L3: single pane 80x24, panel 60x15 -> fitted, pane 60x15', show(put1.body) + ' ' + (await sized(p1)));
const del1 = await fit.release(p1);
const after1 = await snap(w1);
rec(del1.body.released === true && diff(before1, after1) === '' && after1.window.startsWith('80x24'), 'e. fit L3: release gives back 80x24 and everything else exactly', diff(before1, after1) || show(del1.body));

// L4: the two tmux calls the restore leans on, on this tmux version
let layout = '';
let accepted = false;
try { layout = await tmux('display-message', '-p', '-t', w3, '-F', '#{window_layout}'); await tmux('select-layout', '-t', w3, '--', layout); accepted = true; } catch (e) { layout = String(e.stderr || e.message).trim(); }
rec(accepted && strip(await tmux('display-message', '-p', '-t', w3, '-F', '#{window_layout}')) === strip(layout), 'e. fit L4: select-layout -t @W -- <window_layout> is accepted and changes nothing', accepted ? '' : layout);
const unset = await exec('tmux', ['-u', 'show-options', '-w', '-t', w3, 'window-size']).then((r) => r.stdout, (e) => 'error: ' + String(e.stderr || e.message).trim());
rec(unset === '', 'e. fit L4: show-options -w window-size prints nothing while the option is unset', show(unset));

// F4: a control-mode client counts as a terminal. Its stdin is a pipe that stays open until stop(), as iTerm2's tmux integration holds it.
const control = (session) => {
  const child = spawn('tmux', ['-u', '-L', sock, '-C', 'attach-session', '-t', session], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  return { stop: () => { try { child.stdin.end(); } catch { /* already closed */ } child.kill(); } };
};
const clientsOf = (w) => tmux('display-message', '-p', '-t', w, '#{window_active_clients}');
const differs = () => logs.filter((m) => /differs/.test(m));

// F4 (a): a control-mode client shows the 3-pane window -> terminal: the pane is zoomed and tagged, the window is never resized (window-size not manual)
let ctl3 = null;
try {
  ctl3 = control(sess3);
  const attached3 = await until(async () => (await clientsOf(w3)) === '1');
  rec(attached3, 'e. fit F4a: a control-mode client attaches and #{window_active_clients} reads 1 for its window', 'count ' + show(await clientsOf(w3)));
  const putT = await fit.hold(p3, { cols: 120, rows: 40, open: true });
  const duringT = await snap(w3);
  rec(putT.status === 200 && putT.body.fit.state === 'terminal' && putT.body.fit.reason === null && duringT.window.includes('zoomed=1') && duringT.option === '',
    'e. fit F4a: a terminal shows the 3-pane window -> terminal, window zoomed, window-size not manual (never resized)', show(putT.body) + ' ' + duringT.window + ' option=' + show(duringT.option));
  const delT = await fit.release(p3);
  const afterT = await snap(w3);
  rec(delT.body.released === true && !afterT.window.includes('zoomed=1') && afterT.window.includes('tag=[]') && afterT.option === '' && differs().length === 0,
    'e. fit F4a: release gives back the zoom, the tag and the option, and logs no difference', show(delT.body) + ' ' + afterT.window + ' ' + show(differs()));
} finally {
  ctl3?.stop();
}

// F4 (b): no terminal -> fitted (the window is resized to the panel); then a control-mode client attaches -> within 2.5 s the size is given back and hold says terminal
let ctl1 = null;
try {
  const put1b = await fit.hold(p1, { cols: 60, rows: 15, open: true });
  rec(put1b.status === 200 && put1b.body.fit.state === 'fitted' && (await sized(p1)) === '60x15', 'e. fit F4b: no terminal -> fitted, pane 60x15', show(put1b.body) + ' ' + (await sized(p1)));
  const t0 = Date.now();
  ctl1 = control(sess1);
  let leftAt = null;
  let last = null;
  const done = await until(async () => {
    if (leftAt === null && (await sized(p1)) !== '60x15') leftAt = Date.now() - t0;
    last = await fit.hold(p1, { cols: 60, rows: 15, open: false });
    return leftAt !== null && last.body?.fit?.state === 'terminal';
  }, 2500);
  rec(leftAt !== null && leftAt <= 2600, 'e. fit F4b: a control-mode client attaches -> within 2.5 s the window is no longer at the panel size', 'after ' + leftAt + ' ms, pane ' + (await sized(p1)));
  rec(done, 'e. fit F4b: and hold answers terminal within the same 2.5 s', show(last?.body) + ' count ' + show(await clientsOf(w1)));
  const del1b = await fit.release(p1);
  rec(del1b.body.released === true && differs().length === 0, 'e. fit F4b: the restore (R9) logs no difference', show(del1b.body) + ' ' + show(differs()));
} finally {
  ctl1?.stop();
}

// F9 (a): the focused page wins. One pane, a control-mode client shows the window. focus true -> fitted (the terminal shows dots), the pane is the panel's size and
// window-size is manual; focus false -> terminal, the size is the terminal's again, window-size is not manual, the tag is still the lease's nonce, the lease is held;
// focus true again -> fitted; the release removes the tag and logs no difference (R9).
let ctl1f = null;
try {
  await until(async () => (await clientsOf(w1)) === '0'); // the control client of F4b is gone
  ctl1f = control(sess1);
  const attached1f = await until(async () => (await clientsOf(w1)) === '1');
  rec(attached1f, 'e. fit F9a: a control-mode client attaches and #{window_active_clients} reads 1 for its window', 'count ' + show(await clientsOf(w1)));
  const diffs0 = differs().length;
  const optionOf = (w) => tmux('show-options', '-w', '-t', w, 'window-size');
  const tagOf = (w) => tmux('display-message', '-p', '-t', w, '#{@nika-fit}');
  const take1 = await fit.hold(p1, { cols: 90, rows: 28, open: true, focus: true });
  const nonce1 = await tagOf(w1);
  rec(take1.status === 200 && take1.body.fit.state === 'fitted' && take1.body.fit.reason === 'terminal' && (await sized(p1)) === '90x28' && (await optionOf(w1)) === 'window-size manual' && nonce1.length === 16,
    'e. fit F9a: focus true with a terminal -> fitted / terminal, pane 90x28, window-size manual', show(take1.body) + ' ' + (await sized(p1)) + ' option=' + show(await optionOf(w1)));
  const give1 = await fit.hold(p1, { cols: 90, rows: 28, open: false, focus: false });
  const gave1 = await until(async () => (await sized(p1)) !== '90x28', 2500);
  rec(give1.status === 200 && give1.body.fit.state === 'terminal' && gave1 && (await optionOf(w1)) !== 'window-size manual' && (await tagOf(w1)) === nonce1 && fit.size() === 1,
    'e. fit F9a: focus false -> terminal, the terminal has its size again, window-size not manual, the tag is still the nonce, the lease is held', show(give1.body) + ' ' + (await sized(p1)) + ' option=' + show(await optionOf(w1)) + ' size ' + fit.size());
  const again1 = await fit.hold(p1, { cols: 90, rows: 28, open: false, focus: true });
  rec(again1.status === 200 && again1.body.fit.state === 'fitted' && again1.body.fit.reason === 'terminal' && (await sized(p1)) === '90x28',
    'e. fit F9a: focus true again -> fitted / terminal, pane 90x28', show(again1.body) + ' ' + (await sized(p1)));
  const del1f = await fit.release(p1);
  rec(del1f.body.released === true && (await tagOf(w1)) === '' && differs().length === diffs0 && fit.size() === 0,
    'e. fit F9a: the release removes the tag and logs no difference (R9)', show(del1f.body) + ' tag=' + show(await tagOf(w1)) + ' ' + show(differs()));
} finally {
  ctl1f?.stop();
}

// F9 (b): three panes, a control-mode client (80x24), a panel bigger than that. focus true -> fitted and zoomed; focus false -> terminal, still zoomed, still 3 panes
// (no flash of the other panes); the release unzooms and logs no difference.
let ctl3f = null;
try {
  await until(async () => (await clientsOf(w3)) === '0'); // the control client of F4a is gone
  ctl3f = control(sess3);
  const attached3f = await until(async () => (await clientsOf(w3)) === '1');
  rec(attached3f, 'e. fit F9b: a control-mode client attaches and #{window_active_clients} reads 1 for the 3-pane window', 'count ' + show(await clientsOf(w3)));
  const diffs3 = differs().length;
  const take3 = await fit.hold(p3, { cols: 120, rows: 40, open: true, focus: true });
  const during3f = await snap(w3);
  rec(take3.status === 200 && take3.body.fit.state === 'fitted' && during3f.window.includes('zoomed=1') && (await sized(p3)) === '120x40',
    'e. fit F9b: focus true -> fitted, the window is zoomed, pane 120x40', show(take3.body) + ' ' + during3f.window + ' ' + (await sized(p3)));
  const give3 = await fit.hold(p3, { cols: 120, rows: 40, open: false, focus: false });
  const gave3 = await until(async () => (await sized(p3)) !== '120x40', 2500);
  const mid3f = await snap(w3);
  rec(give3.status === 200 && give3.body.fit.state === 'terminal' && gave3 && mid3f.window.includes('zoomed=1') && mid3f.window.includes('panes=3'),
    'e. fit F9b: focus false -> terminal, the window is still zoomed and still has 3 panes', show(give3.body) + ' ' + mid3f.window + ' ' + (await sized(p3)));
  const del3f = await fit.release(p3);
  const after3f = await snap(w3);
  rec(del3f.body.released === true && !after3f.window.includes('zoomed=1') && after3f.window.includes('tag=[]') && differs().length === diffs3,
    'e. fit F9b: the release unzooms, removes the tag and logs no difference (R9)', show(del3f.body) + ' ' + after3f.window + ' ' + show(differs()));
} finally {
  ctl3f?.stop();
}

// F15a (no terminal shows @W15, panel 60x20 is smaller than the window in both directions). It asserts, in this order:
//  1. no focus -> zoomed / panel-smaller: the window is still 100x29, zoom flag 1, 3 panes, tagged (this snapshot is the reference for the gives);
//  2. focus true -> fitted: the mirrored pane and the window are 60x20, zoom flag 1, 3 panes, window-size manual (the shell and the agent pane shrank with the window);
//  3. focus false -> zoomed / panel-smaller: window size, stripped layout, window-size option, tag, every pane's size and active flag and the zoom flag are exactly
//     those of step 1 (select-layout of the layout read right before the squeeze, then the mirrored pane zoomed again); steps 2 and 3 run three times over;
//  4. release -> layout, size, zoom, option, active pane and tag exactly as before step 1, and the restore (R9) logs no difference.
{
  const hidden = async () => (await tmux('list-panes', '-t', w15, '-F', '#{pane_id}=#{pane_width}x#{pane_height}')).split('\n').filter((l) => !l.startsWith(p15 + '=')).join(' ');
  const before15 = await snap(w15);
  const diffs15 = differs().length;
  const base15 = await fit.hold(p15, { cols: 60, rows: 20, open: true });
  const ref15 = await snap(w15);
  const hiddenRef = await hidden();
  rec(base15.status === 200 && base15.body.fit.state === 'zoomed' && base15.body.fit.reason === 'panel-smaller' && ref15.window.startsWith('100x29 zoomed=1 panes=3 tag=[') && !ref15.window.endsWith('tag=[]'),
    'e. fit F15a: no focus -> zoomed / panel-smaller, window still 100x29, zoomed, 3 panes, tagged', show(base15.body) + ' ' + ref15.window);
  const badTake = [];
  const badGive = [];
  let squeezedHidden = '';
  for (let i = 1; i <= 3; i += 1) {
    const take = await fit.hold(p15, { cols: 60, rows: 20, open: false, focus: true });
    const during = await snap(w15);
    const size = await sized(p15);
    squeezedHidden = await hidden();
    if (!(take.status === 200 && take.body.fit.state === 'fitted' && size === '60x20' && during.window.startsWith('60x20 zoomed=1 panes=3 tag=[') && during.option === 'window-size manual')) {
      badTake.push('cycle ' + i + ': ' + show(take.body) + ' pane ' + size + ' window ' + during.window + ' option=' + show(during.option));
    }
    const give = await fit.hold(p15, { cols: 60, rows: 20, open: false, focus: false });
    const after = await snap(w15);
    const changed = diff(ref15, after);
    if (!(give.status === 200 && give.body.fit.state === 'zoomed' && give.body.fit.reason === 'panel-smaller' && changed === '')) {
      badGive.push('cycle ' + i + ': ' + show(give.body) + ' ' + (changed || 'same as the reference'));
    }
  }
  rec(badTake.length === 0, 'e. fit F15a: focus true (3 times) -> fitted, window and pane 60x20, zoomed, 3 panes, window-size manual', badTake.join('; ') || 'hidden panes at 60x20: ' + squeezedHidden + ' (were ' + hiddenRef + ')');
  rec(badGive.length === 0, 'e. fit F15a: focus false (3 times) -> the window\'s size, layout, option, tag, pane sizes, active pane and zoom exactly as before the squeeze', badGive.join('; '));
  const del15 = await fit.release(p15);
  const after15 = await snap(w15);
  const back15 = diff(before15, after15);
  rec(del15.body.released === true && back15 === '' && differs().length === diffs15 && fit.size() === 0,
    'e. fit F15a: the release puts layout0, size, zoom, option, active pane and tag back exactly, and R9 logs no difference', back15 || show(del15.body) + ' ' + show(differs()) + ' size ' + fit.size());
}

rec((await fit.releaseAll()) === 0 && fit.size() === 0, 'e. fit: nothing left held after the releases', 'size ' + fit.size());
JS
  tm_stop
}

check_cleanup() {
  CUR=cleanup
  local left=()
  cleanup
  if [[ -S $TMUX_TMPDIR/tmux-$(id -u)/$SOCK ]] || tm has-session 2>/dev/null; then left+=("tmux server"); fi
  if [[ -n "$(jobs -p)" ]]; then left+=("background job"); fi
  if [[ -e $WORK ]]; then left+=("temp dir"); fi
  if ((${#left[@]} == 0)); then add PASS "f. cleanup: tmux server, child processes and temp dir are gone"
  else add FAIL "f. cleanup left: ${left[*]}"; fi
}

check_npm_test
check_ps
check_handshake
check_tmux
check_fit
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
