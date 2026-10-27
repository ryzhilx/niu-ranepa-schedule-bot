import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niu-api-test-'));
process.env.BOT_DB_PATH = path.join(tmpDir, 'bot.db');

let dbManager;
let directoryCache;
let api;
let originalFetch;

before(async () => {
  ({ dbManager } = await import('../src/db.js'));
  ({ directoryCache } = await import('../src/cache.js'));
  api = await import('../src/api.js');
  originalFetch = global.fetch;
  dbManager.init();
});

after(() => {
  global.fetch = originalFetch;
  try { dbManager?.db?.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
}

function insertDirectoryItem(title, type, id) {
  dbManager.db.prepare(`
    INSERT OR REPLACE INTO directory_items (id, title, type, normalized_title)
    VALUES (?, ?, ?, ?)
  `).run(id === null ? null : String(id), title, type, normalizeTitle(title));
  directoryCache.reload();
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

function textResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text),
    text: async () => text
  };
}

test('getSchedule resolves a group through mobile API and keeps auditorium 315', async () => {
  insertDirectoryItem('Иб-321', 'Group', 12345);

  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse([
      {
        xdt: '2026-10-27 00:00:00',
        nf: '09:00',
        kf: '10:30',
        subject: 'Экономика',
        type: 'Лекция',
        number: '315',
        teacher: 'Иванов И.И.',
        group: 'Иб-321'
      }
    ]);
  };

  const result = await api.getSchedule('Иб-321', '27.10.2026', '27.10.2026');

  assert.equal(result.source, 'mobile');
  assert.equal(result.targetType, 'Group');
  assert.equal(result.totalLessons, 1);
  assert.equal(result.days[0].lessons[0].auditorium, '315');
  assert.ok(calls.every(url => url.includes('/API/public/group/getSchedule')));
  assert.ok(!calls.some(url => url.includes('rasp_json_data')));
});

test('search uses only local auditorium and directory caches', async () => {
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    throw new Error('search must not call the network');
  };

  const results = await api.search('Иб');

  assert.ok(results.some(item => item.type === 'Group' && item.title === 'Иб-321'));
  assert.equal(fetchCalls, 0);
});

test('getSchedule reports unknown targets without a web request', async () => {
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    throw new Error('unknown target must not call the network');
  };

  const result = await api.getSchedule('Несуществующая-999', '27.10.2026', '27.10.2026');

  assert.equal(result.targetType, 'Unknown');
  assert.equal(result.source, 'mobile');
  assert.equal(result.notFound, true);
  assert.equal(result.totalLessons, 0);
  assert.deepEqual(result.days, []);
  assert.equal(fetchCalls, 0);
});

test('getSchedule throws MOBILE_UNAVAILABLE instead of falling back to web', async () => {
  insertDirectoryItem('Сбой-001', 'Group', 777);
  global.fetch = async () => ({ ok: false, status: 503, json: async () => null, text: async () => '' });

  await assert.rejects(
    () => api.getSchedule('Сбой-001', '27.10.2026', '27.10.2026'),
    err => err instanceof api.ScheduleSourceError && err.code === 'MOBILE_UNAVAILABLE'
  );
});

test('getSchedule throws MISSING_OID when the refreshed directory still has no id', async () => {
  insertDirectoryItem('Без-OID-001', 'Group', null);

  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/version')) return textResponse('v2');
    if (value.endsWith('/teachersAndGroupsList')) {
      return jsonResponse([{ value: 'Без-OID-001', type: '0' }]);
    }
    return { ok: false, status: 404, json: async () => [], text: async () => '' };
  };

  await assert.rejects(
    () => api.getSchedule('Без-OID-001', '27.10.2026', '27.10.2026'),
    err => err instanceof api.ScheduleSourceError && err.code === 'MISSING_OID'
  );
});

test('formatScheduleMessages does not mention a web fallback source', () => {
  const messages = api.formatScheduleMessages({
    target: 'Иб-321',
    targetType: 'Group',
    startDate: '27.10.2026',
    endDate: '27.10.2026',
    totalLessons: 0,
    days: [],
    source: 'web'
  });

  assert.equal(messages.length, 1);
  assert.ok(!messages[0].toLowerCase().includes('web'));
  assert.ok(!messages[0].includes('резервный'));
});

test('formatLessonType normalizes known lesson types and strips group suffixes', () => {
  assert.equal(api.formatLessonType('Лек'), 'Лекция');
  assert.equal(api.formatLessonType('Прак, Юоа1-03-26-2'), 'Практика');
  assert.equal(api.formatLessonType('Лаб'), 'Лабораторная работа');
  assert.equal(api.formatLessonType('Сем'), 'Семинар');
  assert.equal(api.formatLessonType('Неизвестный тип'), 'Неизвестный тип');
  assert.equal(api.formatLessonType(''), '');
});

test('formatDayLessonsHtml keeps a group out of the auditorium lesson type line', () => {
  const text = api.formatDayLessonsHtml({
    date: '27.10.2026',
    lessons: [{
      startTime: '09:00',
      endTime: '10:30',
      subject: 'Экономика',
      type: 'Прак, Юоа1-03-26-2',
      auditorium: '315',
      teacher: 'Иванов И.И.',
      group: 'Юоа1-03-26-2'
    }]
  }, 'Auditorium');

  assert.ok(text.includes('<i>Практика</i>'));
  assert.ok(!text.includes('<i>Практика, Юоа1-03-26-2</i>'));
  assert.ok(text.includes('Группа: Юоа1-03-26-2'));
});

test('ensureAuditoriumSchedule refreshes a legacy cache and stores the version', async () => {
  const auditorium = await import('../src/auditorium.js');
  const range = api.getWeekRange(new Date(), 1);
  const [day, month, year] = range.start.split('.').map(Number);
  const dateVal = year * 10000 + month * 100 + day;

  dbManager.db.exec('DELETE FROM auditorium_lessons;');
  dbManager.db.prepare('DELETE FROM directory_meta WHERE key = ?').run('auditoriumCacheVersion');
  dbManager.db.prepare(`
    INSERT INTO auditorium_lessons
    (auditorium, normalized_auditorium, date, date_val, start_time, end_time, subject, type, teacher, group_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('315', '315', range.start, dateVal, '09:00', '10:30', 'Экономика', 'Прак, Юоа1-03-26-2', 'Иванов И.И.', 'Юоа1-03-26-2');

  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/teachersAndGroupsList')) {
      return jsonResponse([{ value: 'Юоа1-03-26-2', type: '0', oid: 101 }]);
    }
    return jsonResponse([{
      xdt: range.start,
      nf: '09:00',
      kf: '10:30',
      subject: 'Экономика',
      type: 'Прак, Юоа1-03-26-2',
      number: '315',
      teacher: 'Иванов И.И.'
    }]);
  };

  const result = await auditorium.ensureAuditoriumSchedule();

  assert.equal(result.groupsSucceeded, 1);
  assert.equal(result.groupsFailed, 0);

  const rows = dbManager.db.prepare('SELECT type, group_name FROM auditorium_lessons').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'Прак');
  assert.equal(rows[0].group_name, 'Юоа1-03-26-2');

  const version = dbManager.db
    .prepare('SELECT value FROM directory_meta WHERE key = ?')
    .get('auditoriumCacheVersion');
  assert.equal(auditorium.AUDITORIUM_CACHE_VERSION, '2');
  assert.equal(version.value, auditorium.AUDITORIUM_CACHE_VERSION);

  global.fetch = async () => {
    throw new Error('cache must be considered fresh after the version bump');
  };
  const second = await auditorium.ensureAuditoriumSchedule();
  assert.equal(second, null);
});
