import { directoryCache } from './cache.js';
import {
  searchAuditoriums,
  getAuditoriumSchedule,
  ensureAuditoriumSchedule,
  normalizeAuditorium
} from './auditorium.js';

const BASE_URL = 'http://services.niu.ranepa.ru/wp-content/plugins/rasp/rasp_json_data.php';
const MOBILE_API_BASE = 'http://services.niu.ranepa.ru/API/public';

export const WEEKDAYS = [
  'Воскресенье',
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота'
];

export const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];

function normalizeArray(items) {
  if (!items) return [];
  if (Array.isArray(items)) return items;
  return [items];
}

export function formatDate(d = new Date()) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

export function parseDate(dateStr) {
  if (dateStr.includes('-') && dateStr.includes(':')) {
    const [d] = dateStr.split(' ');
    const [year, month, day] = d.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  const [day, month, year] = dateStr.split('.').map(Number);
  return new Date(year, month - 1, day);
}

export function getTodayDate(baseDate = new Date()) {
  return formatDate(baseDate);
}

export function getTomorrowDate(baseDate = new Date()) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + 1);
  return formatDate(d);
}

export function getWeekRange(baseDate = new Date(), weekOffset = 0) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + weekOffset * 7);
  const dayOfWeek = d.getDay();
  const diffToMonday = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek;

  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    monday,
    sunday,
    start: formatDate(monday),
    finish: formatDate(sunday)
  };
}

export function parseLessonName(rawName) {
  if (!rawName) return { subject: '', type: '', teacher: '' };

  const parts = rawName.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);
  const lessonPart = parts[0] || '';
  const teacher = parts.slice(1).join(', ') || '';

  let subject = lessonPart;
  let type = '';

  if (lessonPart.endsWith(')')) {
    let depth = 0;
    let openIdx = -1;
    for (let i = lessonPart.length - 1; i >= 0; i--) {
      if (lessonPart[i] === ')') depth++;
      else if (lessonPart[i] === '(') {
        depth--;
        if (depth === 0) {
          openIdx = i;
          break;
        }
      }
    }
    if (openIdx > 0) {
      type = lessonPart.slice(openIdx + 1, -1).trim();
      subject = lessonPart.slice(0, openIdx).trim();
    }
  }

  return { subject, type, teacher };
}

export async function search(query) {
  if (!query || query.trim().length === 0) return [];
  await directoryCache.init();
  await ensureAuditoriumSchedule();

  const audMatches = searchAuditoriums(query);
  const localMatches = directoryCache.search(query);

  const combined = [...audMatches, ...localMatches];
  if (combined.length > 0) {
    return combined;
  }

  const cleanQuery = query.trim();
  const url = `${BASE_URL}?name=${encodeURIComponent(cleanQuery)}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Node.js NIU RANEPA Schedule Bot)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rawItems = data?.GetNameUidForRaspResult?.ItemRaspUID;
    const items = normalizeArray(rawItems);

    const mapped = items.map(item => ({
      id: item.id,
      type: item.Type,
      title: item.Title
    }));

    for (const m of mapped) {
      if (m.type === 'Prep') directoryCache.addTeacher(m.title, m.id);
      else if (m.type === 'Group') directoryCache.addGroup(m.title);
    }

    return mapped;
  } catch (err) {
    console.error(`[search error: "${cleanQuery}"]:`, err.message);
    return [];
  }
}

async function fetchMobileSchedule(endpoint, id, startDate, finishDate) {
  const url = `${MOBILE_API_BASE}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      id: String(id),
      dateBegin: startDate,
      dateEnd: finishDate
    }).toString()
  });

  if (!res.ok) {
    throw new Error(`Mobile API HTTP ${res.status}`);
  }

  const items = await res.json();
  return items;
}

export async function getSchedule(target, startDate, finishDate) {
  if (!target) throw new Error('Target is required');
  let cleanTarget = target.trim();
  const dstart = startDate || formatDate(new Date());
  const dfinish = finishDate || dstart;

  await ensureAuditoriumSchedule();

  if (/^(?:аудитория|аудитории|ауд|кабинет|каб)[.\s]*/i.test(cleanTarget) || cleanTarget.startsWith('Ауд.')) {
    return getAuditoriumSchedule(cleanTarget, dstart, dfinish);
  }

  const audResults = searchAuditoriums(cleanTarget, 1);
  if (audResults.length > 0 && normalizeAuditorium(audResults[0].id) === normalizeAuditorium(cleanTarget)) {
    return getAuditoriumSchedule(audResults[0].id, dstart, dfinish);
  }

  await directoryCache.init();

  let knownOid = null;
  let targetType = 'Unknown';

  const teacherObj = directoryCache.getTeacher(cleanTarget);
  if (teacherObj) {
    targetType = 'Prep';
    cleanTarget = teacherObj.title;
    knownOid = teacherObj.id;
  } else {
    const groupObj = directoryCache.getGroup(cleanTarget);
    if (groupObj) {
      targetType = 'Group';
      cleanTarget = groupObj.title;
      knownOid = groupObj.id;
    }
  }

  if (knownOid && targetType !== 'Unknown') {
    try {
      const endpoint = targetType === 'Prep' ? 'teacher/getSchedule' : 'group/getSchedule';
      const mobileItems = await fetchMobileSchedule(endpoint, knownOid, dstart, dfinish);

      const startVal = parseDate(dstart).getTime();
      const finishVal = parseDate(dfinish).getTime();

      const parsedLessons = (mobileItems || [])
        .map(item => {
          let dateStr = item.xdt || dstart;
          if (dateStr.includes(' ')) {
            const [dPart] = dateStr.split(' ');
            const [y, m, d] = dPart.split('-');
            dateStr = `${d}.${m}.${y}`;
          }

          return {
            date: dateStr,
            startTime: item.nf || '',
            endTime: item.kf || '',
            subject: item.subject || '',
            type: item.type || '',
            auditorium: item.number || '',
            teacher: item.teacher || '',
            group: item.group || '',
            changeNote: null
          };
        })
        .filter(l => {
          const t = parseDate(l.date).getTime();
          return t >= startVal && t <= finishVal;
        });

      const byDateMap = new Map();
      for (const lesson of parsedLessons) {
        if (!byDateMap.has(lesson.date)) {
          byDateMap.set(lesson.date, []);
        }
        byDateMap.get(lesson.date).push(lesson);
      }

      const days = [];
      for (const [dateStr, lessons] of byDateMap.entries()) {
        const dateObj = parseDate(dateStr);
        days.push({
          date: dateStr,
          dateObj,
          dayOfWeek: WEEKDAYS[dateObj.getDay()] || '',
          lessons: lessons.sort((a, b) => a.startTime.localeCompare(b.startTime))
        });
      }

      days.sort((a, b) => a.dateObj - b.dateObj);

      return {
        target: cleanTarget,
        targetType,
        startDate: dstart,
        endDate: dfinish,
        totalLessons: parsedLessons.length,
        days
      };
    } catch (err) {
      console.warn(`[Mobile API error for ${cleanTarget}, falling back to web]:`, err.message);
    }
  }

  const url = `${BASE_URL}?user=${encodeURIComponent(cleanTarget)}&dstart=${dstart}&dfinish=${dfinish}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Node.js NIU RANEPA Schedule Bot)' }
  });

  if (!res.ok) {
    throw new Error(`Schedule API HTTP ${res.status}`);
  }

  const text = await res.text();
  if (!text || text.trim() === 'null') {
    return {
      target: cleanTarget,
      targetType: 'Unknown',
      startDate: dstart,
      endDate: dfinish,
      totalLessons: 0,
      days: []
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse schedule JSON: ${e.message}`);
  }

  let rawItems = [];
  if (data?.GetRaspGroupResult) {
    targetType = 'Group';
    rawItems = normalizeArray(data.GetRaspGroupResult.RaspItem);
  } else if (data?.GetRaspPrepResult) {
    targetType = 'Prep';
    rawItems = normalizeArray(data.GetRaspPrepResult.RaspItem);
  }

  const startVal = parseDate(dstart).getTime();
  const finishVal = parseDate(dfinish).getTime();

  const allLessons = rawItems.map(item => {
    const { subject, type, teacher } = parseLessonName(item.name);
    return {
      date: item.date,
      startTime: item.timestart,
      endTime: item.timefinish,
      subject: subject || item.name,
      type: type || '',
      auditorium: item.aydit || '',
      teacher: teacher || '',
      group: item.namegroup || '',
      changeNote: item.OldState || null
    };
  });

  directoryCache.learnFromLessons(allLessons);
  if (targetType === 'Group') {
    directoryCache.addGroup(cleanTarget);
  } else if (targetType === 'Prep') {
    directoryCache.addTeacher(cleanTarget);
  }

  const parsedLessons = allLessons.filter(l => {
    const t = parseDate(l.date).getTime();
    return t >= startVal && t <= finishVal;
  });

  const byDateMap = new Map();
  for (const lesson of parsedLessons) {
    if (!byDateMap.has(lesson.date)) {
      byDateMap.set(lesson.date, []);
    }
    byDateMap.get(lesson.date).push(lesson);
  }

  const days = [];
  for (const [dateStr, lessons] of byDateMap.entries()) {
    const dateObj = parseDate(dateStr);
    days.push({
      date: dateStr,
      dateObj,
      dayOfWeek: WEEKDAYS[dateObj.getDay()] || '',
      lessons: lessons.sort((a, b) => a.startTime.localeCompare(b.startTime))
    });
  }

  days.sort((a, b) => a.dateObj - b.dateObj);

  return {
    target: cleanTarget,
    targetType,
    startDate: dstart,
    endDate: dfinish,
    totalLessons: parsedLessons.length,
    days
  };
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatDayHeader(dateStr) {
  const [day, month, year] = dateStr.split('.').map(Number);
  const d = new Date(year, month - 1, day);
  const dayName = WEEKDAYS[d.getDay()] || '';
  const monthName = MONTHS_GENITIVE[month - 1] || '';
  return `<b>${dayName}, ${day} ${monthName}</b>`;
}

export function formatDayLessonsHtml(dayData, targetType = 'Group') {
  let text = `${formatDayHeader(dayData.date)}\n`;
  text += `────────────────────\n`;

  if (!dayData.lessons || dayData.lessons.length === 0) {
    text += `<i>Занятий нет.</i>\n\n`;
    return text;
  }

  for (let i = 0; i < dayData.lessons.length; i++) {
    const l = dayData.lessons[i];
    const num = i + 1;
    text += `${num}. <code>${l.startTime} - ${l.endTime}</code>`;
    if (targetType !== 'Auditorium' && l.auditorium) {
      text += ` | Ауд. <b>${escapeHtml(l.auditorium)}</b>`;
    }
    text += `\n`;

    text += `<b>${escapeHtml(l.subject)}</b>\n`;
    if (l.type) {
      text += `<i>${escapeHtml(l.type)}</i>\n`;
    }
    if (targetType === 'Auditorium') {
      if (l.group) text += `Группа: ${escapeHtml(l.group)}\n`;
      if (l.teacher) text += `Преподаватель: ${escapeHtml(l.teacher)}\n`;
    } else if (targetType === 'Group' && l.teacher) {
      text += `Преподаватель: ${escapeHtml(l.teacher)}\n`;
    } else if (targetType === 'Prep' && l.group) {
      text += `Группа: ${escapeHtml(l.group)}\n`;
    }

    if (l.changeNote) {
      text += `Внимание: <i>${escapeHtml(l.changeNote)}</i>\n`;
    }
    text += `\n`;
  }

  return text;
}

export function formatScheduleMessages(scheduleResult) {
  const { target, targetType, startDate, endDate, totalLessons, days } = scheduleResult;
  const isRange = startDate !== endDate;

  let titleHeader = '';
  if (targetType === 'Auditorium') {
    titleHeader = `Аудитория: <b>${escapeHtml(target.replace(/^Ауд\.\s*/i, ''))}</b>\n`;
  } else if (targetType === 'Prep') {
    titleHeader = `Преподаватель: <b>${escapeHtml(target)}</b>\n`;
  } else {
    titleHeader = `Группа: <b>${escapeHtml(target)}</b>\n`;
  }

  if (isRange) {
    titleHeader += `Период: <code>${startDate}</code> — <code>${endDate}</code>\n`;
  }
  titleHeader += `\n`;

  if (totalLessons === 0) {
    const dateText = isRange ? `в период с ${startDate} по ${endDate}` : `на ${startDate}`;
    return [
      `${titleHeader}Занятий ${dateText} не найдено.`
    ];
  }

  const messages = [];
  let currentChunk = titleHeader;

  for (const day of days) {
    const dayText = formatDayLessonsHtml(day, targetType);

    if (currentChunk.length + dayText.length > 3500 && currentChunk.length > titleHeader.length) {
      messages.push(currentChunk.trim());
      currentChunk = dayText;
    } else {
      currentChunk += dayText;
    }
  }

  if (currentChunk.trim().length > 0) {
    messages.push(currentChunk.trim());
  }

  return messages;
}
