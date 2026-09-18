/**
 * In-memory sliding window counter.
 *
 * Every detector in this folder asks the same question: "how many X happened
 * in the last N seconds?". Answering that from MongoDB would mean a write and
 * a query on every message, for data that is worthless thirty seconds later.
 * The database stores what was *detected*; this holds the raw signal.
 *
 * State is per-process and lost on restart. That is acceptable: a restart
 * clears the window, and a raider who paused for the duration of a restart was
 * not being caught by a 20-second window anyway.
 */
export class SlidingWindow {
  /** @param {number} windowMs how far back entries stay relevant */
  constructor(windowMs) {
    this.windowMs = windowMs;
    /** @type {Map<string, Array<{ at: number, data: any }>>} */
    this.entries = new Map();
  }

  /** Record an event and return everything still inside the window. */
  hit(key, data = null, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = (this.entries.get(key) ?? []).filter((e) => e.at > cutoff);
    list.push({ at: now, data });
    this.entries.set(key, list);
    return list;
  }

  /** Read without recording. */
  peek(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    return (this.entries.get(key) ?? []).filter((e) => e.at > cutoff);
  }

  reset(key) {
    this.entries.delete(key);
  }

  /**
   * Drop keys with no live entries. Without this the map grows by one key per
   * user who ever spoke and never shrinks — a slow leak on a busy server.
   */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.entries) {
      const live = list.filter((e) => e.at > cutoff);
      if (live.length) this.entries.set(key, live);
      else this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }
}
