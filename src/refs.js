import crypto from 'crypto';
import { dbManager } from './db.js';




const memory = new Map();
let tableReady = false;

function ensureTable() {
  if (tableReady) return;
  dbManager.init();
  dbManager.db.exec(`
    CREATE TABLE IF NOT EXISTS ref_codes (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      value TEXT NOT NULL
    );
  `);
  tableReady = true;
}

export function makeRef(kind, value) {
  if (!value) return '';
  const code = crypto
    .createHash('md5')
    .update(`${kind}:${value}`)
    .digest('hex')
    .slice(0, 12);

  if (!memory.has(code)) {
    memory.set(code, { kind, value });
    ensureTable();
    dbManager.db
      .prepare('INSERT OR IGNORE INTO ref_codes (code, kind, value) VALUES (?, ?, ?)')
      .run(code, kind, value);
  }
  return code;
}

export function resolveRef(code) {
  if (!code) return null;

  const cached = memory.get(code);
  if (cached) return cached;

  ensureTable();
  const row = dbManager.db
    .prepare('SELECT kind, value FROM ref_codes WHERE code = ?')
    .get(code);
  if (!row) return null;

  const obj = { kind: row.kind, value: row.value };
  memory.set(code, obj);
  return obj;
}
