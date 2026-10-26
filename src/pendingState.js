

export const PENDING_TARGET = 'target';
export const PENDING_SEARCH = 'search';

const TTL_MS = 10 * 60 * 1000;
const states = new Map();

function prune(now) {
  for (const [id, s] of states) {
    if (now - s.ts > TTL_MS) states.delete(id);
  }
}

export const pending = {
  set(userId, kind) {
    states.set(String(userId), { kind, ts: Date.now() });
  },

  clear(userId) {
    states.delete(String(userId));
  },

  is(userId, kind) {
    const now = Date.now();
    prune(now);
    const s = states.get(String(userId));
    return Boolean(s && s.kind === kind);
  },

  has(userId) {
    prune(Date.now());
    return states.has(String(userId));
  }
};
