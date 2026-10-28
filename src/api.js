import { directoryCache } from './cache.js';
import { fetchWithTimeout } from './http.js';
import {
  searchAuditoriums,
  getAuditoriumSchedule,
  ensureAuditoriumSchedule,
  normalizeAuditorium
} from './auditorium.js';
import { refreshDirectoryIfNeeded } from './crawler.js';

const MOBILE_API_BASE = 'http://services.niu.ranepa.ru/API/public';

export const MAX_MESSAGE_LENGTH = 3500;

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

const LESSON_TYPE_LABELS = new Map([
  ['лек', 'Лекция'],
  ['лекция', 'Лекция'],
  ['прак', 'Практика'],
  ['практ', 'Практика'],
  ['практика', 'Практика'],
  ['сем', 'Семинар'],
  ['семинар', 'Семинар'],
  ['лаб', 'Лабораторная работа'],
  ['лабораторная', 'Лабораторная работа'],
  ['лаб.раб', 'Лабораторная работа'],
  ['лабораторная работа', 'Лабораторная работа'],
  ['конс', 'Консультация'],
  ['консультация', 'Консультация'],
  ['экз', 'Экзамен'],
  ['экзамен', 'Экзамен'],
  ['зач', 'Зачёт'],
  ['зачет', 'Зачёт'],
  ['зачёт', 'Зачёт'],
  ['диф.зач', 'Дифференцированный зачёт'],
  ['дифзач', 'Дифференцированный зачёт'],
  ['курс', 'Курсовая работа'],
  ['курсовая', 'Курсовая работа']
]);

export function formatLessonType(rawType) {
  if (!rawType) return '';
  const base = String(rawType).split(',')[0].trim();
  if (!base) return '';
  const key = base.toLowerCase().replace(/[.\s]+$/, '');
  return LESSON_TYPE_LABELS.get(key) ?? base;
}

export class ScheduleSourceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ScheduleSourceError';
    this.code = code;
  }
}

export function formatDate(d = new Date()) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

export function parseDate(dateStr) {
  const value = String(dateStr);
  if (value.includes('-')) {
    const [datePart] = value.split(/[ T]/);
    const [year, month, day] = datePart.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  const [day, month, year] = value.split('.').map(Number);
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

export async function search(query) {
  if (!query || query.trim().length === 0) return [];
  const cleanQuery = query
    .trim()
    .replace(/^\[?(?:преподаватель|преподаватели|преподавателю|преп\.?|преп|учитель)\]?[.:\s]*/i, '')
    .replace(/^\[?(?:группа|группы|группе|гр\.?|гр)\]?[.:\s]*/i, '')
    .replace(/^\[?(?:аудитория|аудитории|аудиторию|ауд\.?|ауд|кабинет|каб\.?|каб)\]?[.:\s]*/i, '')
    .trim();

  if (!cleanQuery) return [];

  await directoryCache.init();

  const audMatches = searchAuditoriums(cleanQuery);
  const localMatches = directoryCache.search(cleanQuery);

  return [...audMatches, ...localMatches];
}

async function fetchMobileSchedule(endpoint, id, startDate, finishDate) {
  const url = `${MOBILE_API_BASE}/${endpoint}`;
  const res = await fetchWithTimeout(url, {
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

  return res.json();
}

function buildScheduleResult(target, targetType, startDate, endDate, lessons) {
  const byDateMap = new Map();
  for (const lesson of lessons) {
    if (!byDateMap.has(lesson.date)) {
      byDateMap.set(lesson.date, []);
    }
    byDateMap.get(lesson.date).push(lesson);
  }

  const days = [];
  for (const [dateStr, dayLessons] of byDateMap.entries()) {
    const dateObj = parseDate(dateStr);
    days.push({
      date: dateStr,
      dateObj,
      dayOfWeek: WEEKDAYS[dateObj.getDay()] || '',
      lessons: dayLessons.sort((a, b) => a.startTime.localeCompare(b.startTime))
    });
  }

  days.sort((a, b) => a.dateObj - b.dateObj);

  return {
    target,
    targetType,
    startDate,
    endDate,
    totalLessons: lessons.length,
    days,
    source: 'mobile'
  };
}

function resolveDirectoryTarget(cleanTarget) {
  const teacherObj = directoryCache.getTeacher(cleanTarget);
  if (teacherObj) {
    return { targetType: 'Prep', title: teacherObj.title, id: teacherObj.id };
  }

  const groupObj = directoryCache.getGroup(cleanTarget);
  if (groupObj) {
    return { targetType: 'Group', title: groupObj.title, id: groupObj.id };
  }

  return { targetType: 'Unknown', title: cleanTarget, id: null };
}

export async function getSchedule(target, startDate, finishDate) {
  if (!target) throw new Error('Target is required');
  let cleanTarget = target
    .trim()
    .replace(/^\[?(?:преподаватель|преподаватели|преподавателю|преп\.?|преп|учитель)\]?[.:\s]*/i, '')
    .replace(/^\[?(?:группа|группы|группе|гр\.?|гр)\]?[.:\s]*/i, '')
    .trim();
  const dstart = startDate || formatDate(new Date());
  const dfinish = finishDate || dstart;

  if (/^(?:аудитория|аудитории|ауд|кабинет|каб)[.\s]*/i.test(cleanTarget) || cleanTarget.startsWith('Ауд.')) {
    await ensureAuditoriumSchedule();
    return {
      ...(await getAuditoriumSchedule(cleanTarget, dstart, dfinish)),
      source: 'auditorium'
    };
  }

  await directoryCache.init();

  const audResults = searchAuditoriums(cleanTarget, 1);
  if (audResults.length > 0 && normalizeAuditorium(audResults[0].id) === normalizeAuditorium(cleanTarget)) {
    await ensureAuditoriumSchedule();
    return {
      ...(await getAuditoriumSchedule(audResults[0].id, dstart, dfinish)),
      source: 'auditorium'
    };
  }

  let resolved = resolveDirectoryTarget(cleanTarget);

  if (resolved.targetType === 'Unknown') {
    return {
      target: cleanTarget,
      targetType: 'Unknown',
      startDate: dstart,
      endDate: dfinish,
      totalLessons: 0,
      days: [],
      source: 'mobile',
      notFound: true
    };
  }

  cleanTarget = resolved.title;

  if (!resolved.id) {
    try {
      await refreshDirectoryIfNeeded({ force: true });
    } catch (err) {
      console.warn(`[directory refresh error for "${cleanTarget}"]:`, err.message);
    }
    resolved = resolveDirectoryTarget(cleanTarget);
    cleanTarget = resolved.title;
  }

  if (!resolved.id || resolved.targetType === 'Unknown') {
    throw new ScheduleSourceError(
      'MISSING_OID',
      `Не удалось определить идентификатор «${cleanTarget}» в мобильном API расписания`
    );
  }

  const endpoint = resolved.targetType === 'Prep' ? 'teacher/getSchedule' : 'group/getSchedule';
  let mobileItems;
  try {
    mobileItems = await fetchMobileSchedule(endpoint, resolved.id, dstart, dfinish);
    if (!Array.isArray(mobileItems)) {
      throw new Error('Mobile API returned a non-array response');
    }
  } catch (err) {
    throw new ScheduleSourceError(
      'MOBILE_UNAVAILABLE',
      `Сервис расписания временно недоступен: ${err.message}`,
      { cause: err }
    );
  }

  const startVal = parseDate(dstart).getTime();
  const finishVal = parseDate(dfinish).getTime();

  const parsedLessons = mobileItems
    .map(item => {
      let dateStr = String(item.xdt || dstart);
      if (dateStr.includes('-')) {
        const [datePart] = dateStr.split(/[ T]/);
        const [y, m, d] = datePart.split('-');
        dateStr = `${d}.${m}.${y}`;
      }

      let lessonType = item.type || '';
      let lessonGroup = item.group || '';
      if (resolved.targetType === 'Group' && !lessonGroup && lessonType.includes(',')) {
        const commaIdx = lessonType.indexOf(',');
        lessonGroup = lessonType.slice(commaIdx + 1).trim();
        lessonType = lessonType.slice(0, commaIdx).trim();
      }

      return {
        date: dateStr,
        startTime: item.nf || '',
        endTime: item.kf || '',
        subject: item.subject || '',
        type: lessonType,
        auditorium: item.number || '',
        teacher: item.teacher || '',
        group: lessonGroup,
        changeNote: null
      };
    })
    .filter(l => {
      const t = parseDate(l.date).getTime();
      return t >= startVal && t <= finishVal;
    });

  return buildScheduleResult(
    cleanTarget,
    resolved.targetType,
    dstart,
    dfinish,
    parsedLessons
  );
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

const MAX_AUDITORIUM_GROUPS = 20;

export function formatAuditoriumGroups(group, limit = MAX_AUDITORIUM_GROUPS) {
  const groups = String(group)
    .split(/[,;]\s*/)
    .map(item => item.trim())
    .filter(Boolean);

  if (groups.length === 0) return '';
  if (groups.length <= limit) {
    return groups.map(escapeHtml).join(', ');
  }

  const shown = groups.slice(0, limit).map(escapeHtml).join(', ');
  const rest = groups.length - limit;
  return `${shown}, и ещё ${rest} групп`;
}

export function formatLessonBlock(lesson, index, targetType = 'Group', options = {}) {
  const { maxAuditoriumGroups = MAX_AUDITORIUM_GROUPS } = options;
  const num = index + 1;
  let text = `${num}. <code>${lesson.startTime} - ${lesson.endTime}</code>`;
  if (targetType !== 'Auditorium' && lesson.auditorium) {
    text += ` | Ауд. <b>${escapeHtml(lesson.auditorium)}</b>`;
  }
  text += `\n`;

  text += `<b>${escapeHtml(lesson.subject)}</b>\n`;
  if (lesson.type) {
    text += `<i>${escapeHtml(formatLessonType(lesson.type))}</i>\n`;
  }
  if (targetType === 'Auditorium') {
    if (lesson.group) text += `Группа: ${formatAuditoriumGroups(lesson.group, maxAuditoriumGroups)}\n`;
    if (lesson.teacher) text += `Преподаватель: ${escapeHtml(lesson.teacher)}\n`;
  } else if (targetType === 'Group' && lesson.teacher) {
    text += `Преподаватель: ${escapeHtml(lesson.teacher)}\n`;
  } else if (targetType === 'Prep' && lesson.group) {
    text += `Группа: ${escapeHtml(lesson.group)}\n`;
  }

  if (lesson.changeNote) {
    text += `Внимание: <i>${escapeHtml(lesson.changeNote)}</i>\n`;
  }
  text += `\n`;

  return text;
}

function formatDaySeparator(dayData) {
  return `${formatDayHeader(dayData.date)}\n────────────────────\n`;
}

export function formatDayLessonsHtml(dayData, targetType = 'Group', options = {}) {
  let text = formatDaySeparator(dayData);

  if (!dayData.lessons || dayData.lessons.length === 0) {
    text += `<i>Занятий нет.</i>\n\n`;
    return text;
  }

  for (let i = 0; i < dayData.lessons.length; i++) {
    text += formatLessonBlock(dayData.lessons[i], i, targetType, options);
  }

  return text;
}

function findSafeCut(text, limit) {
  const newlineCut = text.lastIndexOf('\n', limit);
  if (newlineCut > 0) return newlineCut + 1;

  let cut = Math.min(limit, text.length);

  const lastOpen = text.lastIndexOf('<', cut);
  const lastClose = text.lastIndexOf('>', cut - 1);
  if (lastOpen > lastClose) cut = lastOpen;

  const lastAmp = text.lastIndexOf('&', cut);
  const lastSemi = text.lastIndexOf(';', cut - 1);
  if (lastAmp > lastSemi && cut - lastAmp <= 10) cut = lastAmp;

  return cut > 0 ? cut : Math.min(limit, text.length);
}

const TAG_BALANCE_MARGIN = 32;

function getOpenTags(text) {
  const stack = [];
  const re = /<(\/?)(b|i|code)>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[1] === '/') {
      const idx = stack.lastIndexOf(match[2]);
      if (idx >= 0) stack.length = idx;
    } else {
      stack.push(match[2]);
    }
  }
  return stack;
}

function closeTags(stack) {
  let suffix = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += `</${stack[i]}>`;
  }
  return suffix;
}

function openTags(stack) {
  let prefix = '';
  for (const tag of stack) {
    prefix += `<${tag}>`;
  }
  return prefix;
}

export function splitMessageText(text, limit = MAX_MESSAGE_LENGTH) {
  const source = String(text);
  const max = Math.max(1, limit);
  if (source.length <= max) return [source];

  const parts = [];
  let rest = source;
  let carry = '';

  while (rest.length + carry.length > max) {
    const budget = Math.max(1, max - carry.length - TAG_BALANCE_MARGIN);
    const cut = findSafeCut(rest, budget);
    const body = rest.slice(0, cut);
    rest = rest.slice(cut);

    const piece = carry + body;
    const stack = getOpenTags(piece);
    parts.push(piece + closeTags(stack));
    carry = openTags(stack);
  }

  if (rest.length > 0) parts.push(carry + rest);
  return parts;
}

export function formatScheduleMessages(scheduleResult, options = {}) {
  const { target, targetType, startDate, endDate, totalLessons, days } = scheduleResult;
  const { maxAuditoriumGroups = MAX_AUDITORIUM_GROUPS } = options;
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

  const flushChunk = () => {
    const text = currentChunk.trim();
    if (text.length > 0) messages.push(text);
  };

  for (const day of days) {
    const dayHeader = formatDaySeparator(day);
    const chunkPrefix = titleHeader + dayHeader;

    if (currentChunk.length > titleHeader.length &&
        currentChunk.length + dayHeader.length > MAX_MESSAGE_LENGTH) {
      flushChunk();
      currentChunk = titleHeader;
    }
    currentChunk += dayHeader;

    if (!day.lessons || day.lessons.length === 0) {
      currentChunk += `<i>Занятий нет.</i>\n\n`;
      continue;
    }

    for (let i = 0; i < day.lessons.length; i++) {
      const block = formatLessonBlock(day.lessons[i], i, targetType, { maxAuditoriumGroups });

      if (currentChunk.length + block.length <= MAX_MESSAGE_LENGTH) {
        currentChunk += block;
        continue;
      }

      if (currentChunk.length > chunkPrefix.length) {
        flushChunk();
        currentChunk = chunkPrefix;
      }

      if (currentChunk.length + block.length <= MAX_MESSAGE_LENGTH) {
        currentChunk += block;
        continue;
      }

      const pieces = splitMessageText(block, MAX_MESSAGE_LENGTH - chunkPrefix.length);
      for (let j = 0; j < pieces.length; j++) {
        if (j > 0) {
          flushChunk();
          currentChunk = chunkPrefix;
        }
        currentChunk += pieces[j];
      }
    }
  }

  flushChunk();

  return messages;
}
