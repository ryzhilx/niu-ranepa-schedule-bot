import { dbManager } from './db.js';
import { fetchWithTimeout } from './http.js';
import { syncAuditoriumSchedule } from './auditorium.js';
import { directoryCache } from './cache.js';

const OFFICIAL_LIST_URL = 'http://services.niu.ranepa.ru/API/public/teacher/teachersAndGroupsList';
const VERSION_URL = 'http://services.niu.ranepa.ru/API/public/teacher/teachersAndGroupsList/version';

export async function fetchOfficialDirectory() {
  console.log('Запрос официального справочника мобильного API...');

  const [listRes, verRes] = await Promise.all([
    fetchWithTimeout(OFFICIAL_LIST_URL),
    fetchWithTimeout(VERSION_URL).catch(() => null)
  ]);

  if (!listRes.ok) {
    throw new Error(`Ошибка загрузки: HTTP ${listRes.status}`);
  }

  const rawList = await listRes.json();
  const version = verRes?.ok ? (await verRes.text()).trim() : null;

  const groups = new Set();
  const teachers = new Map();

  for (const item of rawList) {

    const title = (item.value || '').trim();
    if (!title) continue;

    if (item.type === '1') {
      teachers.set(title, {
        title,
        id: item.oid ? Number(item.oid) : null
      });
    } else {
      groups.add(title);
    }
  }

  const teachersArr = [...teachers.values()].sort((a, b) => a.title.localeCompare(b.title));
  const groupsArr = [...groups].sort();

  const data = {
    updatedAt: new Date().toISOString(),
    version,
    teachersCount: teachersArr.length,
    groupsCount: groupsArr.length,
    groups: groupsArr,
    teachers: teachersArr
  };

  dbManager.init();
  dbManager.db.exec('BEGIN TRANSACTION;');
  try {
    const insertMeta = dbManager.db.prepare('INSERT OR REPLACE INTO directory_meta (key, value) VALUES (?, ?)');
    if (version) insertMeta.run('version', version);
    insertMeta.run('updatedAt', new Date().toISOString());

    const insertItem = dbManager.db.prepare(`
      INSERT OR REPLACE INTO directory_items (id, title, type, normalized_title)
      VALUES (?, ?, ?, ?)
    `);

    for (const g of groupsArr) {
      insertItem.run(null, g, 'Group', g.toLowerCase().replace(/[-_ ]/g, ''));
    }

    for (const t of teachersArr) {
      insertItem.run(t.id ? String(t.id) : null, t.title, 'Prep', t.title.toLowerCase().replace(/[-_ ]/g, ''));
    }

    dbManager.db.exec('COMMIT;');
  } catch (err) {
    dbManager.db.exec('ROLLBACK;');
    throw err;
  }

  console.log('Справочник успешно сохранен в SQLite (data/bot.db):');
  console.log(`- Версия (хэш): ${version || 'нет'}`);
  console.log(`- Преподавателей: ${teachersArr.length}`);
  console.log(`- Групп: ${groupsArr.length}`);

  const audRes = await syncAuditoriumSchedule();
  console.log(`- Занятий в аудиториях: ${audRes.totalLessons}`);

  directoryCache.reload();

  return {
    version,
    teachersCount: teachersArr.length,
    groupsCount: groupsArr.length,
    auditoriumLessonsCount: audRes.totalLessons
  };
}

if (process.argv[1] && process.argv[1].endsWith('crawler.js')) {
  fetchOfficialDirectory().catch(err => {
    console.error('Ошибка:', err.message);
    process.exit(1);
  });
}
