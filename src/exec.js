import { execFile } from 'node:child_process';

/**
 * execFile wrapper: fixed argv, no shell, short timeout. Callers add env per command (ps sets TZ/LC_ALL itself;
 * tmux keeps the user's locale, review F10).
 * Resolves { stdout, stderr }; rejects with the child error (err.code = 'ENOENT' when the binary is missing).
 * opts.input (string or Buffer) is written to the child's stdin, which is then closed; without it stdin is untouched.
 */
export function makeExec({ timeout = 3000 } = {}) {
  return (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    const { input } = opts;
    if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) {
      throw new TypeError('exec input must be a string or a Buffer');
    }
    const child = execFile(cmd, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: false,
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (input !== undefined) {
      // A child that exits or fails to start without reading stdin must not crash us with EPIPE.
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
  });
}
