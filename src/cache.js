import { dbManager } from './db.js';

class DirectoryCache {
  constructor() {
    this.groups = new Set();
    this.teachers = new Map();
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;
    this.ensureInit();
  }

  reload() {
    this.loaded = false;
    this.groups.clear();
    this.teachers.clear();
    this.ensureInit();
  }

  addGroup(groupName) {
    if (!groupName) return;
    const clean = groupName.trim();
    if (clean && !this.groups.has(clean)) {
      this.groups.add(clean);
      this.ensureInit();
      const norm = clean.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
      dbManager.db.prepare(`
        INSERT OR IGNORE INTO directory_items (id, title, type, normalized_title)
        VALUES (null, ?, 'Group', ?)
      `).run(clean, norm);
    }
  }

  addTeacher(title, id = null) {
    if (!title) return;
    const clean = title.trim();
    if (clean && !this.teachers.has(clean)) {
      this.teachers.set(clean, { title: clean, id: id ? Number(id) : null });
      this.ensureInit();
      const norm = clean.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
      dbManager.db.prepare(`
        INSERT OR REPLACE INTO directory_items (id, title, type, normalized_title)
        VALUES (?, ?, 'Prep', ?)
      `).run(id ? String(id) : null, clean, norm);
    }
  }

  learnFromLessons(lessons) {
    for (const l of lessons) {
      if (l.group) {
        l.group.split(',').forEach(g => {
          this.addGroup(g);
        });
      }
      if (l.teacher) {
        this.addTeacher(l.teacher);
      }
    }
  }

  getTeacher(title) {
    if (!title) return null;
    this.ensureInit();
    const clean = title.trim();
    if (this.teachers.has(clean)) {
      return this.teachers.get(clean);
    }

    const norm = clean.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
    const row = dbManager.db.prepare(`
      SELECT id, title, type FROM directory_items
      WHERE type = 'Prep' AND (title = ? OR normalized_title = ? OR normalized_title LIKE ?)
      LIMIT 1
    `).get(clean, norm, `%${norm}%`);

    if (row) {
      const obj = { title: row.title, id: row.id ? Number(row.id) : null };
      this.teachers.set(clean, obj);
      return obj;
    }

    const tokens = clean.toLowerCase().split(/[^a-zа-яё0-9]+/).filter(Boolean);
    if (tokens.length > 0) {
      const allPrep = dbManager.db.prepare("SELECT id, title, type FROM directory_items WHERE type = 'Prep'").all();
      const match = allPrep.find(t => {
        const words = t.title.toLowerCase().split(/\s+/);
        return tokens.every((token, idx) => {
          if (idx === 0) return words[0].includes(token);
          return words.slice(1).some(w => w.startsWith(token));
        });
      });
      if (match) {
        const obj = { title: match.title, id: match.id ? Number(match.id) : null };
        this.teachers.set(clean, obj);
        return obj;
      }
    }

    return null;
  }

  getGroup(title) {
    if (!title) return null;
    this.ensureInit();
    const clean = title.trim();
    if (this.groups.has(clean)) {
      return { title: clean, id: null };
    }

    const norm = clean.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
    const row = dbManager.db.prepare(`
      SELECT id, title, type FROM directory_items
      WHERE type = 'Group' AND (title = ? OR normalized_title = ? OR normalized_title LIKE ?)
      LIMIT 1
    `).get(clean, norm, `%${norm}%`);

    if (row) {
      this.groups.add(row.title);
      return { title: row.title, id: row.id ? Number(row.id) : null };
    }

    return null;
  }

  search(query, limit = 8) {
    if (!query) return [];
    this.ensureInit();
    const clean = query.trim();
    const norm = clean.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');

    const rows = dbManager.db.prepare(`
      SELECT id, title, type FROM directory_items
      WHERE normalized_title LIKE ?
      ORDER BY CASE WHEN normalized_title LIKE ? THEN 1 ELSE 2 END, title
      LIMIT ?
    `).all(`%${norm}%`, `${norm}%`, limit);

    const results = rows.map(r => ({
      type: r.type,
      title: r.title,
      id: r.id ? Number(r.id) : null
    }));

    if (results.length > 0) {
      return results;
    }

    const tokens = clean.toLowerCase().split(/[^a-zа-яё0-9]+/).filter(Boolean);
    if (tokens.length > 0) {
      const allPrep = dbManager.db.prepare("SELECT id, title, type FROM directory_items WHERE type = 'Prep'").all();
      const prepMatches = allPrep.filter(t => {
        const words = t.title.toLowerCase().split(/\s+/);
        return tokens.every((token, idx) => {
          if (idx === 0) return words[0].includes(token);
          return words.slice(1).some(w => w.startsWith(token));
        });
      }).slice(0, limit);

      return prepMatches.map(r => ({
        type: r.type,
        title: r.title,
        id: r.id ? Number(r.id) : null
      }));
    }

    return [];
  }

  ensureInit() {
    if (!this.loaded) {
      dbManager.init();
      const rows = dbManager.db.prepare('SELECT id, title, type FROM directory_items').all();
      for (const r of rows) {
        if (r.type === 'Prep') {
          this.teachers.set(r.title, { title: r.title, id: r.id ? Number(r.id) : null });
        } else {
          this.groups.add(r.title);
        }
      }
      this.loaded = true;
    }
  }
}

export const directoryCache = new DirectoryCache();
