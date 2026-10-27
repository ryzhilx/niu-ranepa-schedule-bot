import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niu-crawler-test-'));
process.env.BOT_DB_PATH = path.join(tmpDir, 'bot.db');

let dbManager;
let fetchOfficialDirectory;
let originalFetch;

before(async () => {
  ({ dbManager } = await import('../src/db.js'));
  ({ fetchOfficialDirectory } = await import('../src/crawler.js'));
  originalFetch = global.fetch;
  dbManager.init();
});

beforeEach(() => {
  dbManager.db.exec('DELETE FROM directory_items;');
  dbManager.db.exec('DELETE FROM directory_meta;');
});

after(() => {
  global.fetch = originalFetch;
  try { dbManager?.db?.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mockDirectoryFetch(items, version = 'v1') {
  global.fetch = async (url) => {
    if (String(url).endsWith('/version')) {
      return { ok: true, status: 200, text: async () => version, json: async () => version };
    }

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(items),
      json: async () => items
    };
  };
}

test('directory upsert keeps an existing id when incoming oid is missing', async () => {
  dbManager.db.prepare(`
    INSERT INTO directory_items (id, title, type, normalized_title)
    VALUES ('42', 'Группа-1', 'Group', 'группа1')
  `).run();

  mockDirectoryFetch([
    { value: 'Группа-1', type: '0' },
    { value: '   ', type: '0' },
    { value: 'Преподаватель-1', type: '1', oid: 7 }
  ]);

  await fetchOfficialDirectory({ syncAuditoria: false });

  const group = dbManager.db.prepare(`
    SELECT id FROM directory_items WHERE title = 'Группа-1' AND type = 'Group'
  `).get();
  const teacher = dbManager.db.prepare(`
    SELECT id FROM directory_items WHERE title = 'Преподаватель-1' AND type = 'Prep'
  `).get();

  assert.equal(group.id, '42');
  assert.equal(teacher.id, '7');
  assert.equal(dbManager.db.prepare('SELECT count(*) AS count FROM directory_items').get().count, 2);
});

test('abnormally small directory response leaves the database untouched', async () => {
  const insert = dbManager.db.prepare(`
    INSERT INTO directory_items (id, title, type, normalized_title)
    VALUES (NULL, ?, 'Group', ?)
  `);
  for (let i = 0; i < 100; i++) {
    insert.run(`Группа-${i}`, `группа${i}`);
  }

  mockDirectoryFetch(
    Array.from({ length: 10 }, (_, i) => ({ value: `Группа-${i}`, type: '0' })),
    'v2'
  );

  await assert.rejects(
    () => fetchOfficialDirectory({ syncAuditoria: false }),
    /неполным/
  );

  assert.equal(dbManager.db.prepare('SELECT count(*) AS count FROM directory_items').get().count, 100);
  assert.equal(dbManager.db.prepare("SELECT value FROM directory_meta WHERE key = 'version'").get(), undefined);
});