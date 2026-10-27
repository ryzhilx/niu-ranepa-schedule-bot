import { dbManager } from './db.js';
import { fetchWithTimeout } from './http.js';
import { getTodayDate, getWeekRange, parseDate, WEEKDAYS } from './api.js';

export function normalizeAuditorium(str) {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/^(?:аудитория|аудитории|ауд|кабинет|каб)[.\s]*/i, '')
    .replace(/[-_ ]/g, '');
}

export function cleanAuditoriumTitle(str) {
  if (!str) return '';
  return str.trim().replace(/^(?:аудитория|аудитории|ауд|кабинет|каб)[.\s]*/i, '').trim();
}

function parseXdtToDateVal(xdt) {
  if (!xdt) return null;
  let dateStr = xdt;
  if (dateStr.includes(' ')) {
    dateStr = dateStr.split(' ')[0];
  }
  let d, m, y;
  if (dateStr.includes('-')) {
    [y, m, d] = dateStr.split('-').map(Number);
  } else if (dateStr.includes('.')) {
    [d, m, y] = dateStr.split('.').map(Number);
  } else {
    return null;
  }
  if (!y || !m || !d || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    return null;
  }
  const pad = (n) => String(n).padStart(2, '0');
  return { dateStr: `${pad(d)}.${pad(m)}.${y}`, dateVal: y * 10000 + m * 100 + d };
}

export const AUDITORIUM_CACHE_VERSION = '2';

function getDateVal(dateStr) {
  const parsed = parseXdtToDateVal(dateStr);
  return parsed ? parsed.dateVal : null;
}

export async function syncAuditoriumSchedule(dateBegin = null, dateEnd = null, groupsInput = null) {
  dbManager.init();

  const dstart = dateBegin || getWeekRange(new Date(), 0).start;
  const dfinish = dateEnd || getWeekRange(new Date(), 1).finish;

  let groups = groupsInput;
  if (!groups) {
    const listRes = await fetchWithTimeout('http://services.niu.ranepa.ru/API/public/teacher/teachersAndGroupsList');
    if (!listRes.ok) {
      throw new Error(`teachersAndGroupsList HTTP ${listRes.status}`);
    }
    const all = await listRes.json();
    groups = all.filter(i => i.type === '0' && i.oid);
  }

  const records = [];
  const succeededGroups = new Set();
  const failedGroups = new Set();
  const concurrency = 10;

  for (let i = 0; i < groups.length; i += concurrency) {
    const chunk = groups.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(async g => {
      try {
        const res = await fetchWithTimeout('http://services.niu.ranepa.ru/API/public/group/getSchedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ id: g.oid, dateBegin: dstart, dateEnd: dfinish }).toString()
        }, 20000);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const list = await res.json();
        if (!Array.isArray(list)) {
          throw new Error('API returned a non-array schedule');
        }
        return { group: g.value, list };
      } catch (err) {
        console.warn(`[auditorium sync error for "${g.value}"]:`, err.message);
        return { group: g.value, list: null };
      }
    }));

    for (const { group, list } of chunkResults) {
      if (!Array.isArray(list)) {
        failedGroups.add(group);
        continue;
      }
      succeededGroups.add(group);
      for (const item of list) {
        const aud = (item.number || '').trim();
        if (!aud) continue;

        const parsed = parseXdtToDateVal(item.xdt);
        if (!parsed) continue;

        let itemType = item.type || '';
        if (itemType.includes(',')) {
          itemType = itemType.slice(0, itemType.indexOf(',')).trim();
        }

        records.push([
          aud,
          normalizeAuditorium(aud),
          parsed.dateStr,
          parsed.dateVal,
          item.nf || '',
          item.kf || '',
          item.subject || '',
          itemType,
          item.teacher || '',
          group
        ]);
      }
    }
  }

  if (groups.length > 0 && succeededGroups.size === 0) {
    throw new Error('Не удалось синхронизировать расписание аудиторий: все группы вернули ошибку');
  }

  const startVal = getDateVal(dstart);
  const finishVal = getDateVal(dfinish);
  const allGroupsSucceeded = failedGroups.size === 0;

  const insertStmt = dbManager.db.prepare(`
    INSERT OR REPLACE INTO auditorium_lessons 
    (auditorium, normalized_auditorium, date, date_val, start_time, end_time, subject, type, teacher, group_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteAllStmt = dbManager.db.prepare(
    'DELETE FROM auditorium_lessons WHERE date_val >= ? AND date_val <= ?'
  );
  const deleteGroupStmt = dbManager.db.prepare(
    'DELETE FROM auditorium_lessons WHERE date_val >= ? AND date_val <= ? AND group_name = ?'
  );
  const metaStmt = dbManager.db.prepare('INSERT OR REPLACE INTO directory_meta (key, value) VALUES (?, ?)');

  dbManager.db.exec('BEGIN TRANSACTION;');
  try {
    if (groups.length > 0 && startVal !== null && finishVal !== null) {
      if (allGroupsSucceeded) {
        deleteAllStmt.run(startVal, finishVal);
      } else {
        for (const group of succeededGroups) {
          deleteGroupStmt.run(startVal, finishVal, group);
        }
      }
    }

    for (const rec of records) {
      insertStmt.run(...rec);
    }

    metaStmt.run('lastAuditoriumSync', new Date().toISOString());
    metaStmt.run('auditoriumCacheVersion', AUDITORIUM_CACHE_VERSION);

    dbManager.db.exec('COMMIT;');
  } catch (err) {
    dbManager.db.exec('ROLLBACK;');
    throw err;
  }

  return {
    totalLessons: records.length,
    groupsSucceeded: succeededGroups.size,
    groupsFailed: failedGroups.size
  };
}

export async function ensureAuditoriumSchedule() {
  dbManager.init();
  const countRow = dbManager.db.prepare('SELECT count(*) as count FROM auditorium_lessons').get();
  const versionRow = dbManager.db
    .prepare('SELECT value FROM directory_meta WHERE key = ?')
    .get('auditoriumCacheVersion');

  if (countRow.count > 0 && versionRow?.value === AUDITORIUM_CACHE_VERSION) {
    return null;
  }

  return syncAuditoriumSchedule();
}

export function searchAuditoriums(query, limit = 8) {
  if (!query) return [];
  dbManager.init();

  const norm = normalizeAuditorium(query);
  if (!norm) return [];

  const rows = dbManager.db.prepare(`
    SELECT DISTINCT auditorium
    FROM auditorium_lessons
    WHERE normalized_auditorium LIKE ?
    ORDER BY CASE WHEN normalized_auditorium = ? THEN 1 WHEN normalized_auditorium LIKE ? THEN 2 ELSE 3 END, auditorium
    LIMIT ?
  `).all(`%${norm}%`, norm, `${norm}%`, limit);

  return rows.map(r => ({
    type: 'Aud',
    title: `Ауд. ${r.auditorium}`,
    id: r.auditorium
  }));
}

export function getAuditoriumSchedule(auditoriumQuery, startDate, endDate) {
  dbManager.init();

  const audClean = cleanAuditoriumTitle(auditoriumQuery);
  const normAud = normalizeAuditorium(audClean);

  const dstart = startDate || getTodayDate();
  const dfinish = endDate || dstart;

  const [sd, sm, sy] = dstart.split('.').map(Number);
  const startVal = sy * 10000 + sm * 100 + sd;

  const [fd, fm, fy] = dfinish.split('.').map(Number);
  const finishVal = fy * 10000 + fm * 100 + fd;

  const rows = dbManager.db.prepare(`
    SELECT auditorium, date, date_val, start_time, end_time, subject, type, teacher, group_name
    FROM auditorium_lessons
    WHERE normalized_auditorium = ? AND date_val >= ? AND date_val <= ?
    ORDER BY date_val, start_time
  `).all(normAud, startVal, finishVal);

  const officialAud = rows[0]?.auditorium || audClean;

  const byDateMap = new Map();

  for (const r of rows) {
    if (!byDateMap.has(r.date)) {
      byDateMap.set(r.date, new Map());
    }
    const dayMap = byDateMap.get(r.date);
    const timeKey = `${r.start_time}-${r.end_time}-${r.subject}-${r.teacher}`;

    if (!dayMap.has(timeKey)) {
      dayMap.set(timeKey, {
        date: r.date,
        startTime: r.start_time,
        endTime: r.end_time,
        subject: r.subject,
        type: r.type,
        auditorium: r.auditorium,
        teacher: r.teacher,
        groups: [r.group_name],
        group: r.group_name
      });
    } else {
      const existing = dayMap.get(timeKey);
      if (!existing.groups.includes(r.group_name)) {
        existing.groups.push(r.group_name);
        existing.group = existing.groups.join(', ');
      }
    }
  }

  const days = [];
  for (const [dateStr, dayMap] of byDateMap.entries()) {
    const dateObj = parseDate(dateStr);
    const lessons = Array.from(dayMap.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));
    days.push({
      date: dateStr,
      dateObj,
      dayOfWeek: WEEKDAYS[dateObj.getDay()] || '',
      lessons
    });
  }

  days.sort((a, b) => a.dateObj - b.dateObj);

  const totalLessons = days.reduce((acc, d) => acc + d.lessons.length, 0);

  return {
    target: `Ауд. ${officialAud}`,
    auditorium: officialAud,
    targetType: 'Auditorium',
    startDate: dstart,
    endDate: dfinish,
    totalLessons,
    days
  };
}
