// ── Event Bus — Simple pub/sub ────────────────────────────

class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this.listeners.get(event);
    if (set) set.delete(callback);
  }

  emit(event, data) {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        try { cb(data); } catch (e) { console.error(`Event '${event}' handler error:`, e); }
      }
    }
  }
}

export const events = new EventBus();
