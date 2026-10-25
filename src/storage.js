import { dbManager } from './db.js';

class Storage {
  constructor() {
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;
    dbManager.init();
    this.loaded = true;
  }

  getUser(userId) {
    this.ensureInit();
    const row = dbManager.db.prepare(`
      SELECT id, target, type, notifications, created_at as createdAt, updated_at as updatedAt
      FROM users WHERE id = ?
    `).get(String(userId));

    if (!row) return null;
    return {
      ...row,
      notifications: Boolean(row.notifications)
    };
  }

  async setUserTarget(userId, target, type = 'Group') {
    this.ensureInit();
    if (type !== 'Group') {
      throw new Error('В качестве профиля можно выбрать только учебную группу');
    }
    const id = String(userId);
    const existing = this.getUser(id);
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt || now;
    const notifications = existing ? (existing.notifications ? 1 : 0) : 1;

    dbManager.db.prepare(`
      INSERT OR REPLACE INTO users (id, target, type, notifications, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, target, 'Group', notifications, createdAt, now);

    return this.getUser(id);
  }

  async setNotifications(userId, enabled) {
    this.ensureInit();
    const id = String(userId);
    const now = new Date().toISOString();

    dbManager.db.prepare(`
      UPDATE users SET notifications = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, now, id);

    return this.getUser(id);
  }

  getActiveTargets() {
    this.ensureInit();
    const rows = dbManager.db.prepare(`
      SELECT id, target, type FROM users
      WHERE target IS NOT NULL AND notifications = 1
    `).all();

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.target)) {
        map.set(r.target, {
          target: r.target,
          type: r.type || 'Group',
          userIds: [r.id]
        });
      } else {
        map.get(r.target).userIds.push(r.id);
      }
    }
    return Array.from(map.values());
  }

  getUsersByTarget(target) {
    this.ensureInit();
    const rows = dbManager.db.prepare(`
      SELECT id, target, type, notifications, created_at as createdAt, updated_at as updatedAt
      FROM users WHERE target = ? AND notifications = 1
    `).all();

    return rows.map(r => ({
      ...r,
      notifications: Boolean(r.notifications)
    }));
  }

  async clearUser(userId) {
    this.ensureInit();
    dbManager.db.prepare('DELETE FROM users WHERE id = ?').run(String(userId));
  }

  ensureInit() {
    if (!this.loaded) {
      dbManager.init();
      this.loaded = true;
    }
  }
}

export const storage = new Storage();
