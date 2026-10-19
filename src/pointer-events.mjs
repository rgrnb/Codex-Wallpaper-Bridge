// No document/page/event objects cross this boundary. Coordinates refer only to
// the wallpaper source, normalized after reversing its presentation crop.
export class PointerEvents {
  constructor({ clock = Date.now, maxClicks = 8, maxAge = 250 } = {}) {
    this.clock = clock; this.maxClicks = maxClicks; this.maxAge = maxAge; this.rows = new Map(); this.order = 0;
  }
  clear() { this.rows.clear(); }
  remove(windowKey) { this.rows.delete(windowKey); }
  accept(windowKey, payload, { enabled, generation, token, visible }) {
    if (!enabled || !visible || !Number.isSafeInteger(generation) || generation < 0 || typeof payload !== 'string' || payload.length > 512) return false;
    let value; try { value = JSON.parse(payload); } catch { return false; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 6 ||
        Object.keys(value).some(key => !['token', 'generation', 'sequence', 'type', 'x', 'y'].includes(key))) return false;
    if (value.token !== token || value.generation !== generation || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
        !['move', 'click'].includes(value.type) || !Number.isFinite(value.x) || !Number.isFinite(value.y) ||
        value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) return false;
    const previous = this.rows.get(windowKey);
    if (previous && value.sequence <= previous.sequence) return false;
    const row = previous || { clicks: [] };
    row.sequence = value.sequence;
    const event = { windowKey, generation, type: value.type, x: value.x, y: value.y, receivedAt: this.clock(), order: ++this.order };
    if (value.type === 'move') row.move = event;
    else {
      row.move = null; // A click supersedes a pending move at the same position.
      if (row.clicks.length >= this.maxClicks) row.clicks.shift();
      row.clicks.push(event);
    }
    this.rows.set(windowKey, row); return true;
  }
  drain(generation, isCurrent) {
    const events = [], now = this.clock();
    for (const [key, row] of this.rows) {
      if (!isCurrent(key)) { this.rows.delete(key); continue; }
      for (const value of [...row.clicks, ...(row.move ? [row.move] : [])]) {
        if (value.generation !== generation || now - value.receivedAt > this.maxAge || value.receivedAt > now) continue;
        events.push(value);
      }
      row.clicks = []; row.move = null;
    }
    // Keep the original receive time while the coordinator awaits earlier
    // backend requests. Draining must never grant an old click a fresh lease.
    return events.sort((a, b) => a.order - b.order).map(({ order, ...event }) => event);
  }
}
