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

  addGroup(groupName) {
    if (!groupName) return;
    const clean = groupName.trim();
    if (clean && !this.groups.has(clean)) {
      this.groups.add(clean);
      this.ensureInit();
      const norm = clean.toLowerCase().replace(/[-_ ]/g, '');
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
      const norm = clean.toLowerCase().replace(/[-_ ]/g, '');
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

  search(query, limit = 8) {
    if (!query) return [];
    this.ensureInit();
    const clean = query.trim();
    const norm = clean.toLowerCase().replace(/[-_ ]/g, '');

    const rows = dbManager.db.prepare(`
      SELECT id, title, type FROM directory_items
      WHERE normalized_title LIKE ?
      ORDER BY CASE WHEN normalized_title LIKE ? THEN 1 ELSE 2 END, title
      LIMIT ?
    `).all(`%${norm}%`, `${norm}%`, limit);

    return rows.map(r => ({
      type: r.type,
      title: r.title,
      id: r.id ? Number(r.id) : null
    }));
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
