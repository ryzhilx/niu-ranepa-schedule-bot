import { dbManager } from './db.js';

class DirectoryCache {
  constructor() {
    this.groups = new Map();
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

  cleanPrefix(str) {
    if (!str) return '';
    return str
      .trim()
      .replace(/^\[?(?:преподаватель|преподаватели|преподавателю|преп\.?|преп|учитель)\]?[.:\s]*/i, '')
      .replace(/^\[?(?:группа|группы|группе|гр\.?|гр)\]?[.:\s]*/i, '')
      .replace(/^\[?(?:аудитория|аудитории|аудиторию|ауд\.?|ауд|кабинет|каб\.?|каб)\]?[.:\s]*/i, '')
      .trim();
  }

  addGroup(groupName, id = null) {
    if (!groupName) return;
    const clean = this.cleanPrefix(groupName);
    if (!clean) return;

    const numericId = id !== null && id !== undefined && id !== '' ? Number(id) : null;
    const validId = Number.isFinite(numericId) ? numericId : null;

    this.ensureInit();

    if (!this.groups.has(clean)) {
      this.groups.set(clean, validId);
      const norm = clean.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
      dbManager.db.prepare(`
        INSERT OR IGNORE INTO directory_items (id, title, type, normalized_title)
        VALUES (?, ?, 'Group', ?)
      `).run(validId !== null ? String(validId) : null, clean, norm);
    } else if (validId !== null && this.groups.get(clean) === null) {
      this.groups.set(clean, validId);
      dbManager.db.prepare(`
        UPDATE directory_items SET id = ?
        WHERE title = ? AND type = 'Group' AND (id IS NULL OR id = '')
      `).run(String(validId), clean);
    }
  }

  addTeacher(title, id = null) {
    if (!title) return;
    const clean = this.cleanPrefix(title);
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
    const clean = this.cleanPrefix(title);
    if (!clean) return null;

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

    const stopWords = new Set(['преподаватель', 'преподаватели', 'преп', 'учитель']);
    const tokens = clean.toLowerCase().split(/[^a-zа-яё0-9]+/).filter(t => t.length > 0 && !stopWords.has(t));
    if (tokens.length > 0) {
      const allPrep = dbManager.db.prepare("SELECT id, title, type FROM directory_items WHERE type = 'Prep'").all();
      const match = allPrep.find(t => {
        const words = t.title.toLowerCase().split(/\s+/);
        return tokens.every(token => words.some(w => w.startsWith(token)));
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
    const clean = this.cleanPrefix(title);
    if (!clean) return null;

    const norm = clean.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');

    if (this.groups.has(clean)) {
      const cachedId = this.groups.get(clean);
      return { title: clean, id: cachedId === null ? null : Number(cachedId) };
    }

    const row = dbManager.db.prepare(`
      SELECT id, title, type FROM directory_items
      WHERE type = 'Group' AND (title = ? OR normalized_title = ? OR normalized_title LIKE ?)
      LIMIT 1
    `).get(clean, norm, `%${norm}%`);

    if (row) {
      const id = row.id ? Number(row.id) : null;
      this.groups.set(row.title, id);
      return { title: row.title, id };
    }

    return null;
  }

  search(query, limit = 8) {
    if (!query) return [];
    this.ensureInit();
    const clean = this.cleanPrefix(query);
    if (!clean) return [];

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

    const stopWords = new Set(['преподаватель', 'преподаватели', 'преп', 'учитель', 'группа', 'ауд', 'аудитория']);
    const tokens = clean.toLowerCase().split(/[^a-zа-яё0-9]+/).filter(t => t.length > 0 && !stopWords.has(t));
    if (tokens.length > 0) {
      const allPrep = dbManager.db.prepare("SELECT id, title, type FROM directory_items WHERE type = 'Prep'").all();
      const prepMatches = allPrep.filter(t => {
        const words = t.title.toLowerCase().split(/\s+/);
        return tokens.every(token => words.some(w => w.startsWith(token)));
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
          this.groups.set(r.title, r.id ? Number(r.id) : null);
        }
      }
      this.loaded = true;
    }
  }
}

export const directoryCache = new DirectoryCache();
