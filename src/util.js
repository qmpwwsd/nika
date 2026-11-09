/** Promise.all with at most `limit` tasks in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * A Map that holds at most `max` entries: get() refreshes an entry's recency, set() puts it last and drops the oldest past
 * `max`, resize() changes the cap (shrinking drops the oldest at once). has() and a miss touch nothing. A `max` that is not a
 * finite number of at least 1 becomes 1, never "unbounded".
 */
class Lru extends Map {
  constructor(max) {
    super();
    this.max = 1;
    this.resize(max);
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    super.delete(key);
    super.set(key, value);
    this.#trim();
    return this;
  }

  resize(max) {
    this.max = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
    this.#trim();
  }

  #trim() {
    while (this.size > this.max) super.delete(super.keys().next().value);
  }
}

export const lru = (max) => new Lru(max);
