// A small concurrency limiter (0.5.4 SF, RV051 M7: moved out of the history collector so the attachment store does not depend on a collector).
// A leaf module: it imports nothing. Keep this file ASCII.

/** Runs at most `max` async tasks at once; the rest wait in FIFO order. A slot is released even when a task throws. */
export function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve)); // the finishing task hands its slot over
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
