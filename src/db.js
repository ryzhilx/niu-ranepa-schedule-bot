import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.BOT_DB_PATH
  ? path.resolve(process.env.BOT_DB_PATH)
  : path.join(DEFAULT_DATA_DIR, 'bot.db');
const DATA_DIR = process.env.BOT_DB_PATH ? path.dirname(DB_PATH) : DEFAULT_DATA_DIR;

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    this.db = new DatabaseSync(DB_PATH);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');

    this.initTables();
    this.migrateSnapshotSource();
    this.migrateFromJson();

    this.initialized = true;
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        target TEXT,
        type TEXT,
        notifications INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        target TEXT PRIMARY KEY,
        target_type TEXT,
        lessons_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source TEXT
      );

      CREATE TABLE IF NOT EXISTS directory_items (
        id TEXT,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        PRIMARY KEY (title, type)
      );

      CREATE TABLE IF NOT EXISTS directory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auditorium_lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auditorium TEXT NOT NULL,
        normalized_auditorium TEXT NOT NULL,
        date TEXT NOT NULL,
        date_val INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        subject TEXT NOT NULL,
        type TEXT,
        teacher TEXT,
        group_name TEXT,
        UNIQUE(auditorium, date, start_time, group_name, subject)
      );

      CREATE INDEX IF NOT EXISTS idx_directory_normalized ON directory_items(normalized_title);
      CREATE INDEX IF NOT EXISTS idx_directory_type ON directory_items(type);
      CREATE INDEX IF NOT EXISTS idx_aud_norm ON auditorium_lessons(normalized_auditorium);
      CREATE INDEX IF NOT EXISTS idx_aud_date ON auditorium_lessons(normalized_auditorium, date_val);
    `);
  }

  migrateSnapshotSource() {
    const columns = this.db.prepare('PRAGMA table_info(snapshots)').all();
    if (!columns.some(column => column.name === 'source')) {
      this.db.exec('ALTER TABLE snapshots ADD COLUMN source TEXT;');
    }
  }

  migrateFromJson() {
    const usersCount = this.db.prepare('SELECT count(*) as count FROM users').get().count;
    const usersFile = path.join(DATA_DIR, 'users.json');
    if (usersCount === 0 && fs.existsSync(usersFile)) {
      try {
        const raw = fs.readFileSync(usersFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const insertUser = this.db.prepare(`
          INSERT OR REPLACE INTO users (id, target, type, notifications, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const [id, u] of Object.entries(parsed)) {
          insertUser.run(
            String(id),
            u.target || null,
            u.type || 'Group',
            u.notifications !== false ? 1 : 0,
            u.createdAt || new Date().toISOString(),
            u.updatedAt || new Date().toISOString()
          );
        }
      } catch (err) {
        console.error('[db user migration error]:', err.message);
      }
    }

    const snapCount = this.db.prepare('SELECT count(*) as count FROM snapshots').get().count;
    const snapFile = path.join(DATA_DIR, 'snapshots.json');
    if (snapCount === 0 && fs.existsSync(snapFile)) {
      try {
        const raw = fs.readFileSync(snapFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const insertSnap = this.db.prepare(`
          INSERT OR REPLACE INTO snapshots (target, target_type, lessons_json, updated_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const [target, s] of Object.entries(parsed)) {
          insertSnap.run(
            target,
            s.targetType || 'Group',
            JSON.stringify(s.lessons || []),
            s.updatedAt || new Date().toISOString()
          );
        }
      } catch (err) {
        console.error('[db snapshot migration error]:', err.message);
      }
    }

    const dirCount = this.db.prepare('SELECT count(*) as count FROM directory_items').get().count;
    const dirFile = path.join(DATA_DIR, 'directory.json');
    if (dirCount === 0 && fs.existsSync(dirFile)) {
      try {
        const raw = fs.readFileSync(dirFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const insertMeta = this.db.prepare('INSERT OR REPLACE INTO directory_meta (key, value) VALUES (?, ?)');
        if (parsed.version) insertMeta.run('version', parsed.version);
        if (parsed.updatedAt) insertMeta.run('updatedAt', parsed.updatedAt);

        const insertItem = this.db.prepare(`
          INSERT OR REPLACE INTO directory_items (id, title, type, normalized_title)
          VALUES (?, ?, ?, ?)
        `);

        if (Array.isArray(parsed.groups)) {
          for (const g of parsed.groups) {
            insertItem.run(null, g, 'Group', g.toLowerCase().replace(/[-_ ]/g, ''));
          }
        }

        if (Array.isArray(parsed.teachers)) {
          for (const t of parsed.teachers) {
            insertItem.run(t.id ? String(t.id) : null, t.title, 'Prep', t.title.toLowerCase().replace(/[-_ ]/g, ''));
          }
        }
      } catch (err) {
        console.error('[db directory migration error]:', err.message);
      }
    }
  }
}

export const dbManager = new DatabaseManager();
