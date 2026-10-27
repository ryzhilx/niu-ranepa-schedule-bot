import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niu-watcher-test-'));
process.env.BOT_DB_PATH = path.join(tmpDir, 'bot.db');

let dbManager;
let directoryCache;
let api;
let watcherModule;
let scheduleWatcher;
let originalFetch;

before(async () => {
  ({ dbManager } = await import('../src/db.js'));
  ({ directoryCache } = await import('../src/cache.js'));
  api = await import('../src/api.js');
  watcherModule = await import('../src/watcher.js');
  scheduleWatcher = watcherModule.scheduleWatcher;
  originalFetch = global.fetch;

  dbManager.init();

  dbManager.db.prepare(`
    INSERT OR REPLACE INTO directory_items (id, title, type, normalized_title)
    VALUES (?, ?, 'Group', ?)
  `).run('12345', 'Иб-321', 'иб321');

  dbManager.db.prepare(`
    INSERT OR REPLACE INTO directory_items (id, title, type, normalized_title)
    VALUES (?, ?, 'Group', ?)
  `).run('888', 'Сбой-321', 'сбой321');

  const today = api.getTodayDate();
  insertSnapshot('Иб-321', 'web', [legacyLesson(today)]);
  insertSnapshot('Сбой-321', 'mobile', [legacyLesson(today)]);
  insertSnapshot('Нет-999', 'mobile', [legacyLesson(today)]);

  directoryCache.reload();
  await scheduleWatcher.init();
});

after(() => {
  global.fetch = originalFetch;
  try { dbManager?.db?.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function legacyLesson(date) {
  return {
    date,
    startTime: '09:00',
    endTime: '10:30',
    subject: 'Экономика',
    type: 'Лекция',
    auditorium: '326',
    teacher: 'Иванов И.И.',
    group: 'Иб-321',
    changeNote: null
  };
}

function insertSnapshot(target, source, lessons) {
  dbManager.db.prepare(`
    INSERT OR REPLACE INTO snapshots (target, target_type, lessons_json, updated_at, source)
    VALUES (?, 'Group', ?, ?, ?)
  `).run(target, JSON.stringify(lessons), new Date().toISOString(), source);
}

function mobileItem(date) {
  const [d, m, y] = date.split('.');
  return {
    xdt: `${y}-${m}-${d} 00:00:00`,
    nf: '09:00',
    kf: '10:30',
    subject: 'Экономика',
    type: 'Лекция',
    number: '315',
    teacher: 'Иванов И.И.',
    group: 'Иб-321'
  };
}

test('legacy snapshot is rebased once through mobile API', async () => {
  const today = api.getTodayDate();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [mobileItem(today)],
    text: async () => ''
  });

  const result = await scheduleWatcher.checkTarget('Иб-321');

  assert.equal(result.success, true);
  assert.equal(result.rebased, true);
  assert.equal(result.hasChanges, false);

  const row = dbManager.db.prepare('SELECT source, lessons_json FROM snapshots WHERE target = ?').get('Иб-321');
  assert.equal(row.source, 'mobile');
  const lessons = JSON.parse(row.lessons_json);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].auditorium, '315');
});

test('unknown target does not overwrite an existing snapshot', async () => {
  const beforeRow = dbManager.db.prepare('SELECT source, lessons_json FROM snapshots WHERE target = ?').get('Нет-999');

  const result = await scheduleWatcher.checkTarget('Нет-999');

  assert.equal(result.success, false);
  assert.match(result.error, /не найдена/i);

  const afterRow = dbManager.db.prepare('SELECT source, lessons_json FROM snapshots WHERE target = ?').get('Нет-999');
  assert.equal(afterRow.source, beforeRow.source);
  assert.equal(afterRow.lessons_json, beforeRow.lessons_json);
});

test('mobile API failure keeps the previous snapshot intact', async () => {
  const beforeRow = dbManager.db.prepare('SELECT source, lessons_json FROM snapshots WHERE target = ?').get('Сбой-321');
  global.fetch = async () => ({ ok: false, status: 503, json: async () => null, text: async () => '' });

  const result = await scheduleWatcher.checkTarget('Сбой-321');

  assert.equal(result.success, false);
  assert.match(result.error, /временно недоступен/i);

  const afterRow = dbManager.db.prepare('SELECT source, lessons_json FROM snapshots WHERE target = ?').get('Сбой-321');
  assert.equal(afterRow.source, beforeRow.source);
  assert.equal(afterRow.lessons_json, beforeRow.lessons_json);
});

test('diffLessonsForDay reports an auditorium change', () => {
  const oldLessons = [legacyLesson('27.10.2026')];
  const newLessons = [{ ...legacyLesson('27.10.2026'), auditorium: '315' }];

  const changes = watcherModule.diffLessonsForDay(oldLessons, newLessons);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'modified');
  assert.match(changes[0].details, /326/);
  assert.match(changes[0].details, /315/);
});
