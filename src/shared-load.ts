/**
 * One load at a time, shared by everyone asking, and kept for `ms`. Something anyone can ask for without signing in
 * (the realm list) can't turn a burst of requests into a burst at Proxmox. A failed load isn't kept (#59).
 */
export function sharedLoad<T>(ms: number, load: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let value: Promise<T> | null = null;
  let at = 0;
  return () => {
    if (value && now() - at <= ms) return value;
    at = now();
    const mine = load();
    value = mine;
    mine.catch(() => {
      if (value === mine) value = null;
    });
    return mine;
  };
}
