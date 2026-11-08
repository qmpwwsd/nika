#!/usr/bin/env bash
# GUI smoke test of the nika desktop shell on Linux (CI job `gui-smoke`; locally: Dockerfile.test, target gui).
# Builds the debug shell, runs it under Xvfb on a private session bus, with scripts/shell-probe.mjs standing in for the
# Node server (passed as NIKA_NODE). The probe serves a page, a real WebKitGTK window loads it, and the page reports what
# the window may and may not do. Exit 0 only when every probe check is PASS.
# Needs: cargo, node 22, xvfb-run (xvfb, xauth), dbus-run-session (dbus-x11), timeout, and the Tauri build dependencies.
# NIKA_SMOKE_NO_SANDBOX=1 turns the WebKit sandbox off: only for a container without user namespaces, never in CI.
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "gui-smoke: Linux only (this is $(uname -s)). Locally: docker build -f Dockerfile.test --target gui -t nika-gui ." >&2
  echo "  && docker run --rm -e NIKA_SMOKE_NO_SANDBOX=1 nika-gui" >&2
  exit 2
fi
for tool in cargo node xvfb-run dbus-run-session timeout mktemp; do
  command -v "$tool" >/dev/null || { echo "gui-smoke: missing tool: $tool" >&2; exit 2; }
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"

echo "== build the debug shell"
(cd app/src-tauri && cargo build --locked)
SHELL_BIN="$REPO/app/src-tauri/target/debug/nika-app"
[[ -x $SHELL_BIN ]] || { echo "gui-smoke: $SHELL_BIN was not built" >&2; exit 1; }

WORK="$(mktemp -d)"
RUN_PID=
cleanup() {
  if [[ -n $RUN_PID ]]; then kill -TERM "$RUN_PID" 2>/dev/null || true; wait "$RUN_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# The wrapper the shell runs as "node": a file whose shebang is the real node (absolute) and which loads the probe.
REAL_NODE="$(command -v node)"
[[ $REAL_NODE == /* ]] || { echo "gui-smoke: node is not an absolute path: $REAL_NODE" >&2; exit 2; }
PROBE_URL="$("$REAL_NODE" -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$REPO/scripts/shell-probe.mjs")"
mkdir -m 700 "$WORK/bin" "$WORK/home" "$WORK/nika-config" "$WORK/state" "$WORK/claude"
printf '#!%s\nimport("%s");\n' "$REAL_NODE" "$PROBE_URL" >"$WORK/bin/node"
chmod 755 "$WORK/bin/node"

# Throwaway HOME and dirs: the shell and its child never see the real ones.
export HOME="$WORK/home" NIKA_NODE="$WORK/bin/node" NIKA_CONFIG_DIR="$WORK/nika-config" XDG_STATE_HOME="$WORK/state" \
  CLAUDE_CONFIG_DIR="$WORK/claude" NO_AT_BRIDGE=1 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
unset XDG_CONFIG_HOME XDG_DATA_HOME TMUX TMUX_PANE
if [[ ${NIKA_SMOKE_NO_SANDBOX:-} == 1 ]]; then export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1; fi

echo "== run the shell under Xvfb (limit 150 s)"
ERR="$WORK/shell.err"
# Both streams: Ubuntu's xvfb-run runs the command with `2>&1`, so the probe's result line can arrive on stdout.
timeout -k 5 150 xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- "$SHELL_BIN" >"$ERR" 2>&1 &
RUN_PID=$!

LINE=
for _ in $(seq 1 320); do
  LINE="$(grep -m1 '^{"probe":"nika-shell-probe"' "$ERR" || true)"
  [[ -n $LINE ]] && break
  kill -0 "$RUN_PID" 2>/dev/null || break
  sleep 0.5
done
ALIVE=no
if kill -0 "$RUN_PID" 2>/dev/null; then ALIVE=yes; fi

# Whatever the outcome, stop the shell now (timeout sends the signal to its whole group: Xvfb, bus, shell, probe).
kill -TERM "$RUN_PID" 2>/dev/null || true
wait "$RUN_PID" 2>/dev/null || true
RUN_PID=

echo "== shell stderr, tray and GTK lines (tray: the app indicator without a StatusNotifier host)"
grep -iE 'indicator|tray|statusnotifier|panicked|critical|error while' "$ERR" | grep -v '^{"probe"' | head -n 20 || true
echo "(shell still running when the probe result arrived: $ALIVE)"

if [[ -z $LINE ]]; then
  echo "gui-smoke: FAIL no probe result line. Last 40 lines of the shell's stderr:" >&2
  tail -n 40 "$ERR" >&2 || true
  exit 1
fi

echo "== probe result (JSON)"
printf '%s\n' "$LINE"
echo "== checks"
# shellcheck disable=SC2016 # the JS is single-quoted on purpose: its ${...} must not expand in the shell
printf '%s\n' "$LINE" | "$REAL_NODE" -e '
const r = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
for (const c of r.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  [" + c.detail + "]" : ""}`);
const bad = r.checks.filter((c) => !c.ok).length;
console.log(`\n${r.checks.length - bad} of ${r.checks.length} checks passed (${r.userAgent}).`);
process.exit(r.ok && bad === 0 && r.checks.length >= 19 ? 0 : 1);
'
