import { dbManager } from './db.js';
import { fetchWithTimeout } from './http.js';
import { syncAuditoriumSchedule } from './auditorium.js';
import { directoryCache } from './cache.js';

const OFFICIAL_LIST_URL = 'http://services.niu.ranepa.ru/API/public/teacher/teachersAndGroupsList';
const VERSION_URL = 'http://services.niu.ranepa.ru/API/public/teacher/teachersAndGroupsList/version';

const REFRESH_TTL_MS = 5 * 60 * 1000;
const MIN_DIRECTORY_SIZE_FOR_ANOMALY_CHECK = 50;
const MIN_DIRECTORY_RATIO = 0.5;

let refreshPromise = null;
let lastVersionCheckAt = 0;

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
}

function getMetaValue(key) {
  const row = dbManager.db.prepare('SELECT value FROM directory_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

function getDirectoryCounts() {
  const rows = dbManager.db.prepare(`
    SELECT type, count(*) AS count
    FROM directory_items
    GROUP BY type
  `).all();

  const counts = { Group: 0, Prep: 0 };
  for (const row of rows) {
    if (row.type === 'Group' || row.type === 'Prep') {
      counts[row.type] = Number(row.count) || 0;
    }
  }
  return counts;
}

function countMissingGroupIds() {
  const row = dbManager.db.prepare(`
    SELECT count(*) AS count
    FROM directory_items
    WHERE type = 'Group' AND (id IS NULL OR id = '')
  `).get();
  return Number(row?.count) || 0;
}

function assertDirectorySizeIsPlausible(existingCounts, groupsCount, teachersCount) {
  const checks = [
    ['групп', existingCounts.Group, groupsCount],
    ['преподавателей', existingCounts.Prep, teachersCount]
  ];

  for (const [label, existingCount, newCount] of checks) {
    if (
      existingCount >= MIN_DIRECTORY_SIZE_FOR_ANOMALY_CHECK &&
      newCount < existingCount * MIN_DIRECTORY_RATIO
    ) {
      throw new Error(
        `Справочник ${label} выглядит неполным: было ${existingCount}, пришло ${newCount}. ` +
        'Обновление отменено, база не изменена.'
      );
    }
  }
}

async function fetchDirectoryVersion() {
  const res = await fetchWithTimeout(VERSION_URL);
  if (!res.ok) {
    throw new Error(`Ошибка загрузки версии справочника: HTTP ${res.status}`);
  }
  const version = (await res.text()).trim();
  return version || null;
}

export async function fetchOfficialDirectory({ syncAuditoria = true } = {}) {
  console.log('Запрос официального справочника мобильного API...');

  const [listRes, verRes] = await Promise.all([
    fetchWithTimeout(OFFICIAL_LIST_URL),
    fetchWithTimeout(VERSION_URL).catch(() => null)
  ]);

  if (!listRes.ok) {
    throw new Error(`Ошибка загрузки: HTTP ${listRes.status}`);
  }

  const rawList = await listRes.json();
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error('Мобильный API вернул пустой или некорректный справочник');
  }

  const version = verRes?.ok ? (await verRes.text()).trim() : null;

  const groups = new Map();
  const teachers = new Map();

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;

    const title = String(item.value || '').trim();
    if (!title) continue;

    if (item.type === '1') {
      teachers.set(title, {
        title,
        id: item.oid ? Number(item.oid) : null
      });
    } else {
      groups.set(title, {
        title,
        id: item.oid ? String(item.oid) : null
      });
    }
  }

  const teachersArr = [...teachers.values()].sort((a, b) => a.title.localeCompare(b.title));
  const groupsArr = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));

  if (groupsArr.length === 0 && teachersArr.length === 0) {
    throw new Error('Мобильный API вернул справочник без групп и преподавателей');
  }

  dbManager.init();
  assertDirectorySizeIsPlausible(getDirectoryCounts(), groupsArr.length, teachersArr.length);

  dbManager.db.exec('BEGIN TRANSACTION;');
  try {
    const insertMeta = dbManager.db.prepare('INSERT OR REPLACE INTO directory_meta (key, value) VALUES (?, ?)');
    if (version) insertMeta.run('version', version);
    insertMeta.run('updatedAt', new Date().toISOString());

    const upsertItem = dbManager.db.prepare(`
      INSERT INTO directory_items (id, title, type, normalized_title)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(title, type) DO UPDATE SET
        id = COALESCE(excluded.id, directory_items.id),
        normalized_title = excluded.normalized_title
    `);

    for (const g of groupsArr) {
      upsertItem.run(g.id, g.title, 'Group', normalizeTitle(g.title));
    }

    for (const t of teachersArr) {
      upsertItem.run(t.id ? String(t.id) : null, t.title, 'Prep', normalizeTitle(t.title));
    }

    dbManager.db.exec('COMMIT;');
  } catch (err) {
    dbManager.db.exec('ROLLBACK;');
    throw err;
  }

  directoryCache.reload();

  console.log('Справочник успешно сохранен в SQLite:');
  console.log(`- Версия (хэш): ${version || 'нет'}`);
  console.log(`- Преподавателей: ${teachersArr.length}`);
  console.log(`- Групп: ${groupsArr.length}`);

  const audRes = syncAuditoria ? await syncAuditoriumSchedule() : null;
  if (audRes) {
    console.log(`- Занятий в аудиториях: ${audRes.totalLessons}`);
  } else {
    console.log('- Синхронизация аудиторий пропущена');
  }

  return {
    version,
    teachersCount: teachersArr.length,
    groupsCount: groupsArr.length,
    auditoriumLessonsCount: audRes?.totalLessons ?? null
  };
}

async function runDirectoryRefresh(force, syncAuditoria) {
  dbManager.init();

  const now = Date.now();
  if (!force && !syncAuditoria && lastVersionCheckAt && now - lastVersionCheckAt < REFRESH_TTL_MS) {
    return { updated: false, reason: 'ttl' };
  }
  lastVersionCheckAt = now;

  const localVersion = getMetaValue('version');
  const directoryCounts = getDirectoryCounts();
  const directoryCount = directoryCounts.Group + directoryCounts.Prep;
  const missingGroupIds = countMissingGroupIds();

  let remoteVersion = null;
  let versionError = null;
  try {
    remoteVersion = await fetchDirectoryVersion();
  } catch (err) {
    versionError = err;
  }

  const needsLocalRefresh = force || syncAuditoria || directoryCount === 0 || !localVersion || missingGroupIds > 0;
  const versionChanged = Boolean(remoteVersion && remoteVersion !== localVersion);

  if (!needsLocalRefresh && versionError) {
    throw versionError;
  }

  if (!needsLocalRefresh && !versionChanged) {
    return { updated: false, reason: 'up-to-date', version: remoteVersion };
  }

  const result = await fetchOfficialDirectory({ syncAuditoria });
  return { updated: true, ...result };
}

export async function refreshDirectoryIfNeeded({ force = false, syncAuditoria = false } = {}) {
  if (refreshPromise) return refreshPromise;

  refreshPromise = runDirectoryRefresh(force, syncAuditoria)
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

if (process.argv[1] && process.argv[1].endsWith('crawler.js')) {
  fetchOfficialDirectory().catch(err => {
    console.error('Ошибка:', err.message);
    process.exit(1);
  });
}
