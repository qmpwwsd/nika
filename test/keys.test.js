import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKeys } from '../src/keys.js';
import { KEY_NAME } from '../src/ids.js';

const ESC = '\u001b';

/** Fake tmux: records [cmd, ...args] and the stdin input; `fail(args)` may return an error to throw for that call. */
function fakeTmux(fail) {
  const calls = [];
  const inputs = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    inputs.push(opts.input);
    const err = fail?.(args);
    if (err) throw err;
    return { stdout: '', stderr: '' };
  };
  exec.calls = calls;
  exec.inputs = inputs;
  return exec;
}
const tmuxErr = (stderr, code = 1) => Object.assign(new Error('tmux failed'), { code, stderr });
let t = 1_000_000;
const make = (exec) => createKeys({ exec, tmuxBin: '/opt/x/tmux', now: () => t });
const BUFFER = /^nika-[0-9a-f]{16}$/;

describe('createKeys.send: text and named keys', () => {
  test('(+) text uses send-keys -l -- with the text as one argv element, even when it looks like options', async () => {
    const exec = fakeTmux();
    const r = await make(exec).send('%5', { text: '-x --help; $(rm) 日' });
    assert.deepEqual(r, { status: 200, body: { sent: { text: 18, paste: 0, keys: 0 } } });
    assert.deepEqual(exec.calls, [['/opt/x/tmux', '-u', 'send-keys', '-t', '%5', '-l', '--', '-x --help; $(rm) 日']]);
  });

  test('(+) keys are sent one call each, in order, after the text', async () => {
    const exec = fakeTmux();
    const r = await make(exec).send('%12', { text: 'ls', keys: ['Enter', 'C-c', 'BTab'] });
    assert.deepEqual(r.body, { sent: { text: 2, paste: 0, keys: 3 } });
    assert.deepEqual(exec.calls, [
      ['/opt/x/tmux', '-u', 'send-keys', '-t', '%12', '-l', '--', 'ls'],
      ['/opt/x/tmux', '-u', 'send-keys', '-t', '%12', '--', 'Enter'],
      ['/opt/x/tmux', '-u', 'send-keys', '-t', '%12', '--', 'C-c'],
      ['/opt/x/tmux', '-u', 'send-keys', '-t', '%12', '--', 'BTab'],
    ]);
  });

  test('(+) every KEY_NAME is accepted', async () => {
    for (const key of KEY_NAME) {
      t += 1000;
      assert.equal((await make(fakeTmux()).send('%1', { keys: [key] })).status, 200, key);
    }
  });

  test('(+) exactly 8 keys and exactly 1024 characters are allowed; null fields count as absent', async () => {
    const exec = fakeTmux();
    const k = make(exec);
    assert.equal((await k.send('%1', { keys: Array(8).fill('Down'), text: null, paste: null })).status, 200);
    assert.equal((await k.send('%1', { text: 'x'.repeat(1024) })).body.sent.text, 1024);
    assert.equal((await k.send('%1', { text: '', keys: ['Enter'] })).body.sent.text, 0);
  });

  test('(−) invalid pane ids are refused with 400 and nothing reaches tmux', async () => {
    const exec = fakeTmux();
    const k = make(exec);
    for (const pane of ['', '5', '%', '%x', '%1234567', '%1;ls', '-t', '%1 %2', '=main:', '$(x)', undefined, null, 5, {}]) {
      const r = await k.send(pane, { text: 'a' });
      assert.equal(r.status, 400, String(pane));
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal(exec.calls.length, 0);
  });

  test('(−) text with any C0, DEL or C1 control is refused, nothing is sent', async () => {
    const exec = fakeTmux();
    const k = make(exec);
    const bad = [0x00, 0x03, 0x07, 0x08, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9f];
    for (const cp of bad) {
      t += 1000;
      const r = await k.send('%1', { text: `ab${String.fromCharCode(cp)}cd` });
      assert.equal(r.status, 400, `U+${cp.toString(16)}`);
    }
    assert.equal(exec.calls.length, 0);
  });

  test('(−) text over 1024 characters, bad types, text with paste, too many keys, unknown keys, empty requests are 400', async () => {
    const exec = fakeTmux();
    const k = make(exec);
    const bad = [
      { text: 'x'.repeat(1025) },
      { text: '😀'.repeat(1025) },
      { text: 5 }, { text: {} }, { paste: 5 }, { paste: ['a'] },
      { text: 'a', paste: 'b' },
      { keys: 'Enter' }, { keys: {} }, { keys: Array(9).fill('Enter') },
      { keys: ['Enter', 'C-d'] }, { keys: ['enter'] }, { keys: ['Enter '] }, { keys: ['-l'] }, { keys: [5] }, { keys: [null] }, { keys: ['F1'] },
      { keys: ['__proto__'] }, { keys: [['Enter']] },
      {}, { text: '' }, { keys: [] }, { text: '', paste: '', keys: [] }, { paste: '\u0001\u0002' },
      undefined, null,
    ];
    for (const body of bad) {
      t += 1000;
      const r = await k.send('%1', body);
      assert.equal(r.status, 400, JSON.stringify(body)?.slice(0, 60));
      assert.equal(r.body.error, 'invalid');
      assert.equal(typeof r.body.message, 'string');
    }
    assert.equal(exec.calls.length, 0);
  });
});

describe('createKeys.send: paste', () => {
  test('(+) a paste is loaded from stdin into a private buffer, pasted bracketed with -d, in that order', async () => {
    const exec = fakeTmux();
    const r = await make(exec).send('%7', { paste: 'line one\nline two\n\tindented' });
    assert.deepEqual(r.body, { sent: { text: 0, paste: 27, keys: 0 } });
    assert.equal(exec.calls.length, 2);
    const [load, paste] = exec.calls;
    assert.deepEqual(load.slice(0, 5), ['/opt/x/tmux', '-u', 'load-buffer', '-b', load[4]]);
    assert.match(load[4], BUFFER);
    assert.deepEqual(load.slice(5), ['-']);
    assert.ok(Buffer.isBuffer(exec.inputs[0]));
    assert.equal(exec.inputs[0].toString('utf8'), 'line one\nline two\n\tindented');
    assert.deepEqual(paste, ['/opt/x/tmux', '-u', 'paste-buffer', '-p', '-d', '-b', load[4], '-t', '%7']);
    assert.equal(exec.inputs[1], undefined);
  });

  test('(+) the paste bytes never appear in argv (only on stdin), so the argv size limit cannot bite', async () => {
    const exec = fakeTmux();
    const big = 'abc\n'.repeat(4096); // 16 KB exactly
    assert.equal((await make(exec).send('%7', { paste: big })).status, 200);
    assert.equal(exec.inputs[0].length, 16384);
    assert.ok(exec.calls.every((c) => c.join(' ').length < 200));
  });

  test('(+) CRLF and CR become LF', async () => {
    const exec = fakeTmux();
    const r = await make(exec).send('%7', { paste: 'a\r\nb\rc\n\r\nd' });
    assert.equal(exec.inputs[0].toString(), 'a\nb\nc\n\nd');
    assert.equal(r.body.sent.paste, 8);
  });

  test('(+) text or paste goes first, then the keys, each key one call', async () => {
    const exec = fakeTmux();
    await make(exec).send('%7', { paste: 'hello', keys: ['Enter', 'Up'] });
    assert.deepEqual(exec.calls.map((c) => c[2]), ['load-buffer', 'paste-buffer', 'send-keys', 'send-keys']);
    assert.deepEqual(exec.calls.slice(2).map((c) => c.at(-1)), ['Enter', 'Up']);
  });

  test('(+) every paste uses a fresh random buffer name', async () => {
    const exec = fakeTmux();
    const k = make(exec);
    await k.send('%7', { paste: 'a' });
    await k.send('%7', { paste: 'a' });
    const names = exec.calls.filter((c) => c[2] === 'load-buffer').map((c) => c[4]);
    assert.equal(new Set(names).size, 2);
  });

  test('(−) ESC and every control except tab and newline are stripped, so the bracketed-paste end marker cannot be forged', async () => {
    const exec = fakeTmux();
    const evil = `a${ESC}[201~b${ESC}[200~c\u0000d\u0003e\u0007f\u0008g\u000bh\u000ci\u007fj\u0080k\u009bl\u009fm\tn\no`;
    const r = await make(exec).send('%7', { paste: evil });
    const sent = exec.inputs[0].toString('utf8');
    assert.equal(sent, 'a[201~b[200~cdefghijklm\tn\no');
    assert.ok(!exec.inputs[0].includes(0x1b));
    assert.equal(r.body.sent.paste, [...sent].length);
  });

  test('(−) a paste of 16 KB + 1 bytes is refused; multi-byte characters count as bytes', async () => {
    const exec = fakeTmux();
    const k = make(exec);
    assert.equal((await k.send('%7', { paste: 'x'.repeat(16385) })).status, 400);
    assert.equal((await k.send('%7', { paste: '日'.repeat(5462) })).status, 400); // 16386 bytes
    assert.equal((await k.send('%7', { paste: '日'.repeat(5461) })).status, 200); // 16383 bytes
    assert.equal(exec.calls.length, 2);
  });

  test('(−) text and paste together are refused, nothing is sent', async () => {
    const exec = fakeTmux();
    const r = await make(exec).send('%7', { text: 'a', paste: 'b', keys: ['Enter'] });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /mutually exclusive/);
    assert.equal(exec.calls.length, 0);
  });

  test('(−) a paste that is only controls sends nothing; with keys the keys still go', async () => {
    const exec = fakeTmux();
    const k = make(exec);
    assert.equal((await k.send('%7', { paste: `${ESC}\u0001` })).status, 400);
    const r = await k.send('%7', { paste: `${ESC}\u0001`, keys: ['Enter'] });
    assert.deepEqual(r.body.sent, { text: 0, paste: 0, keys: 1 });
    assert.deepEqual(exec.calls.map((c) => c[2]), ['send-keys']);
  });

  test('(−) when paste-buffer fails the buffer is deleted, an error body comes back and the keys are not sent', async () => {
    const exec = fakeTmux((a) => (a.includes('paste-buffer') ? tmuxErr('some tmux problem\nsecond line') : null));
    const r = await make(exec).send('%7', { paste: 'hello', keys: ['Enter'] });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'tmux_failed');
    assert.equal(r.body.message, 'some tmux problem');
    assert.deepEqual(exec.calls.map((c) => c[2]), ['load-buffer', 'paste-buffer', 'delete-buffer']);
    const name = exec.calls[0][4];
    assert.deepEqual(exec.calls[2], ['/opt/x/tmux', '-u', 'delete-buffer', '-b', name]);
  });

  test('(−) when load-buffer fails nothing is pasted and delete-buffer is still tried', async () => {
    const exec = fakeTmux((a) => (a.includes('load-buffer') ? tmuxErr('command too long') : null));
    const r = await make(exec).send('%7', { paste: 'hello' });
    assert.equal(r.status, 502);
    assert.deepEqual(exec.calls.map((c) => c[2]), ['load-buffer', 'delete-buffer']);
  });

  test('(−) a failing delete-buffer does not hide the original error', async () => {
    const exec = fakeTmux((a) => (a.includes('paste-buffer') ? tmuxErr("can't find pane: %7") : a.includes('delete-buffer') ? tmuxErr('unknown buffer') : null));
    const r = await make(exec).send('%7', { paste: 'hello' });
    assert.equal(r.status, 404);
  });
});

describe('createKeys.send: tmux failures and rate limit', () => {
  test('(−) a pane tmux does not know gives 404 not_found', async () => {
    const r = await make(fakeTmux(() => tmuxErr("can't find pane: %9"))).send('%9', { text: 'a' });
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
  });

  test('(−) tmux missing or no server gives 503 tmux_unavailable', async () => {
    t += 1000;
    const missing = await make(fakeTmux(() => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))).send('%1', { keys: ['Enter'] });
    assert.deepEqual([missing.status, missing.body.error], [503, 'tmux_unavailable']);
    t += 1000;
    const down = await make(fakeTmux(() => tmuxErr('no server running on /tmp/x'))).send('%1', { keys: ['Enter'] });
    assert.equal(down.status, 503);
  });

  test('(−) a key that fails stops the rest of the request', async () => {
    const exec = fakeTmux((a) => (a.at(-1) === 'Down' ? tmuxErr('boom') : null));
    const r = await make(exec).send('%1', { keys: ['Up', 'Down', 'Enter'] });
    assert.equal(r.status, 502);
    assert.equal(exec.calls.length, 2);
  });

  test('(+) 20 requests in a second pass, the 21st gets 429 busy, and the window slides', async () => {
    t = 10_000_000;
    const exec = fakeTmux();
    const k = make(exec);
    for (let i = 0; i < 20; i += 1) {
      t += 10; // 20 requests spread over 200 ms
      assert.equal((await k.send('%1', { keys: ['Up'] })).status, 200, `request ${i + 1}`);
    }
    const busy = await k.send('%1', { keys: ['Up'] });
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error, 'busy');
    assert.equal(exec.calls.length, 20, 'a refused request sends nothing');
    t += 809; // the first request is now 999 ms old: still inside its window
    assert.equal((await k.send('%1', { keys: ['Up'] })).status, 429);
    t += 1; // the first request is now exactly 1000 ms old
    assert.equal((await k.send('%1', { keys: ['Up'] })).status, 200);
    assert.equal((await k.send('%1', { keys: ['Up'] })).status, 429, 'only one slot freed');
  });

  test('(−) the limit is per pane', async () => {
    t = 20_000_000;
    const k = make(fakeTmux());
    for (let i = 0; i < 20; i += 1) await k.send('%1', { keys: ['Up'] });
    assert.equal((await k.send('%1', { keys: ['Up'] })).status, 429);
    assert.equal((await k.send('%2', { keys: ['Up'] })).status, 200);
  });

  test('(−) invalid requests do not use up the allowance; failed tmux calls do', async () => {
    t = 30_000_000;
    const k = make(fakeTmux((a) => (a.includes('send-keys') ? tmuxErr('boom') : null)));
    for (let i = 0; i < 50; i += 1) assert.equal((await k.send('%1', { keys: ['nope'] })).status, 400);
    for (let i = 0; i < 20; i += 1) assert.equal((await k.send('%1', { keys: ['Up'] })).status, 502);
    assert.equal((await k.send('%1', { keys: ['Up'] })).status, 429);
  });

  test('(+) a clock that is not a function falls back to Date.now', async () => {
    const k = createKeys({ exec: fakeTmux(), now: 'soon' });
    assert.equal((await k.send('%1', { keys: ['Up'] })).status, 200);
  });
});
