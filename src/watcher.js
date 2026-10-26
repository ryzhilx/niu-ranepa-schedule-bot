import { InlineKeyboard } from 'grammy';
import {
  getSchedule,
  getTodayDate,
  getWeekRange,
  parseDate,
  WEEKDAYS
} from './api.js';
import { storage } from './storage.js';
import { dbManager } from './db.js';
import { makeRef } from './refs.js';

export function diffLessonsForDay(oldLessons, newLessons) {
  const changes = [];
  const unmatchedOld = [...oldLessons];
  const unmatchedNew = [...newLessons];

  for (let i = unmatchedOld.length - 1; i >= 0; i--) {
    const o = unmatchedOld[i];
    const nIdx = unmatchedNew.findIndex(n =>
      n.startTime === o.startTime &&
      n.endTime === o.endTime &&
      n.subject === o.subject &&
      n.type === o.type &&
      n.auditorium === o.auditorium &&
      n.teacher === o.teacher &&
      n.group === o.group
    );
    if (nIdx !== -1) {
      unmatchedOld.splice(i, 1);
      unmatchedNew.splice(nIdx, 1);
    }
  }

  for (let i = unmatchedOld.length - 1; i >= 0; i--) {
    const o = unmatchedOld[i];
    const nIdx = unmatchedNew.findIndex(n => n.startTime === o.startTime && n.subject === o.subject);
    if (nIdx !== -1) {
      const n = unmatchedNew[nIdx];
      const fieldDiffs = [];
      if (o.auditorium !== n.auditorium) {
        fieldDiffs.push(`аудитория: ${o.auditorium || '—'} -> ${n.auditorium || '—'}`);
      }
      if (o.teacher !== n.teacher && (o.teacher || n.teacher)) {
        fieldDiffs.push(`преподаватель: ${o.teacher || '—'} -> ${n.teacher || '—'}`);
      }
      if (o.type !== n.type && (o.type || n.type)) {
        fieldDiffs.push(`тип: ${o.type || '—'} -> ${n.type || '—'}`);
      }
      if (fieldDiffs.length > 0) {
        changes.push({
          type: 'modified',
          time: `${o.startTime}-${o.endTime}`,
          subject: o.subject,
          details: fieldDiffs.join(', ')
        });
      }
      unmatchedOld.splice(i, 1);
      unmatchedNew.splice(nIdx, 1);
    }
  }

  for (let i = unmatchedOld.length - 1; i >= 0; i--) {
    const o = unmatchedOld[i];
    const nIdx = unmatchedNew.findIndex(n => n.startTime === o.startTime);
    if (nIdx !== -1) {
      const n = unmatchedNew[nIdx];
      const extra = n.auditorium ? ` (ауд. ${n.auditorium})` : '';
      changes.push({
        type: 'replaced',
        time: `${o.startTime}-${o.endTime}`,
        subject: `${o.subject} -> ${n.subject}${extra}`,
        details: 'замена занятия'
      });
      unmatchedOld.splice(i, 1);
      unmatchedNew.splice(nIdx, 1);
    }
  }

  for (let i = unmatchedOld.length - 1; i >= 0; i--) {
    const o = unmatchedOld[i];
    const nIdx = unmatchedNew.findIndex(n => n.subject === o.subject);
    if (nIdx !== -1) {
      const n = unmatchedNew[nIdx];
      const roomDiff = o.auditorium !== n.auditorium ? `, ауд. ${o.auditorium} -> ${n.auditorium}` : '';
      changes.push({
        type: 'moved',
        time: `${o.startTime} -> ${n.startTime}`,
        subject: o.subject,
        details: `перенос пары${roomDiff}`
      });
      unmatchedOld.splice(i, 1);
      unmatchedNew.splice(nIdx, 1);
    }
  }

  for (const o of unmatchedOld) {
    const extra = o.auditorium ? `, ауд. ${o.auditorium}` : '';
    changes.push({
      type: 'cancelled',
      time: `${o.startTime}-${o.endTime}`,
      subject: o.subject,
      details: `пара отменена${extra}`
    });
  }

  for (const n of unmatchedNew) {
    const extra = n.auditorium ? `, ауд. ${n.auditorium}` : '';
    const teacherStr = n.teacher ? ` (${n.teacher})` : '';
    changes.push({
      type: 'added',
      time: `${n.startTime}-${n.endTime}`,
      subject: `${n.subject}${teacherStr}`,
      details: `добавлена пара${extra}`
    });
  }

  return changes;
}

export function diffSchedules(oldLessons, newLessons, todayStr) {
  const todayTimestamp = parseDate(todayStr).getTime();

  const validOld = (oldLessons || []).filter(l => parseDate(l.date).getTime() >= todayTimestamp);
  const validNew = (newLessons || []).filter(l => parseDate(l.date).getTime() >= todayTimestamp);

  const datesSet = new Set([
    ...validOld.map(l => l.date),
    ...validNew.map(l => l.date)
  ]);

  const sortedDates = Array.from(datesSet).sort((a, b) => parseDate(a) - parseDate(b));
  const changesByDay = [];

  for (const date of sortedDates) {
    const dayOld = validOld.filter(l => l.date === date);
    const dayNew = validNew.filter(l => l.date === date);
    const dayChanges = diffLessonsForDay(dayOld, dayNew);

    if (dayChanges.length > 0) {
      const dateObj = parseDate(date);
      changesByDay.push({
        date,
        dayOfWeek: WEEKDAYS[dateObj.getDay()] || '',
        changes: dayChanges
      });
    }
  }

  return {
    hasChanges: changesByDay.length > 0,
    changesByDay
  };
}

export function formatChangesNotification(target, changesByDay) {
  let text = `<b>Изменение в расписании (${target})</b>\n\n`;

  for (const day of changesByDay) {
    text += `<b>${day.date} (${day.dayOfWeek}):</b>\n`;
    for (const c of day.changes) {
      if (c.type === 'modified') {
        text += `— ${c.time} | <b>${c.subject}</b>: ${c.details}\n`;
      } else if (c.type === 'replaced') {
        text += `— ${c.time} | <b>Замена:</b> ${c.subject}\n`;
      } else if (c.type === 'moved') {
        text += `— <b>Перенос:</b> ${c.time} | ${c.subject}${c.details ? ` (${c.details})` : ''}\n`;
      } else if (c.type === 'cancelled') {
        text += `— ${c.time} | <b>Отмена:</b> ${c.subject}${c.details ? ` (${c.details})` : ''}\n`;
      } else if (c.type === 'added') {
        text += `— ${c.time} | <b>Новая пара:</b> ${c.subject}${c.details ? ` (${c.details})` : ''}\n`;
      }
    }
    text += '\n';
  }

  return text.trim();
}

class ScheduleWatcher {
  constructor() {
    this.snapshots = new Map();
    this.loaded = false;
    this.timer = null;
    this.isChecking = false;
  }

  async init() {
    if (this.loaded) return;
    dbManager.init();

    const rows = dbManager.db.prepare('SELECT target, target_type, lessons_json, updated_at FROM snapshots').all();
    for (const r of rows) {
      this.snapshots.set(r.target, {
        target: r.target,
        targetType: r.target_type || 'Group',
        updatedAt: r.updated_at,
        lessons: JSON.parse(r.lessons_json || '[]')
      });
    }

    this.loaded = true;
  }

  saveSnapshot(target, lessons, targetType = 'Group') {
    const updatedAt = new Date().toISOString();
    this.snapshots.set(target, {
      target,
      targetType,
      updatedAt,
      lessons
    });

    dbManager.db.prepare(`
      INSERT OR REPLACE INTO snapshots (target, target_type, lessons_json, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(target, targetType, JSON.stringify(lessons || []), updatedAt);
  }

  async seedTarget(target) {
    await this.init();
    if (this.snapshots.has(target)) return;

    try {
      const today = getTodayDate();
      const nextWeek = getWeekRange(new Date(), 1);
      const sched = await getSchedule(target, today, nextWeek.finish);
      const lessons = sched.days.flatMap(d => d.lessons);

      this.saveSnapshot(target, lessons, sched.targetType);
    } catch (err) {
      console.warn(`[seedTarget error for ${target}]:`, err.message);
    }
  }

  async checkTarget(target, bot = null) {
    await this.init();
    await storage.init();

    const today = getTodayDate();
    const nextWeek = getWeekRange(new Date(), 1);

    let sched;
    try {
      sched = await getSchedule(target, today, nextWeek.finish);
    } catch (err) {
      console.warn(`[watcher check failed for ${target}]:`, err.message);
      return { target, success: false, error: err.message };
    }

    const newLessons = sched.days.flatMap(d => d.lessons);
    const existing = this.snapshots.get(target);

    if (!existing) {
      this.saveSnapshot(target, newLessons, sched.targetType);
      return { target, success: true, seeded: true, hasChanges: false };
    }

    const oldLessons = existing.lessons || [];

    if (oldLessons.length >= 3 && newLessons.length === 0) {
      console.warn(`[watcher suspicious empty schedule for ${target}, skipping update]`);
      return { target, success: true, skipped: true, hasChanges: false };
    }

    const diffResult = diffSchedules(oldLessons, newLessons, today);

    if (diffResult.hasChanges) {
      this.saveSnapshot(target, newLessons, sched.targetType);

      const message = formatChangesNotification(target, diffResult.changesByDay);

      if (bot) {
        const usersToNotify = storage.getUsersByTarget(target);
        const keyboard = new InlineKeyboard().text('Посмотреть расписание', `view:today:${makeRef('target', target)}`);

        for (const user of usersToNotify) {
          try {
            await bot.api.sendMessage(user.id, message, {
              parse_mode: 'HTML',
              reply_markup: keyboard
            });
          } catch (err) {
            if (err.error_code === 403 || err.message?.includes('blocked')) {
              await storage.setNotifications(user.id, false);
            }
          }
        }
      }

      return {
        target,
        success: true,
        hasChanges: true,
        changesByDay: diffResult.changesByDay,
        message
      };
    }

    this.saveSnapshot(target, newLessons, sched.targetType);

    return { target, success: true, hasChanges: false };
  }

  async checkAll(bot = null) {
    if (this.isChecking) return;
    this.isChecking = true;

    const startedAt = Date.now();

    try {
      await storage.init();
      const activeTargets = storage.getActiveTargets();
      const results = [];

      console.log(`[watcher] проверка запущена: целей ${activeTargets.length}`);

      for (const item of activeTargets) {
        const res = await this.checkTarget(item.target, bot);
        results.push(res);

        if (res.success === false) {
          console.log(`[watcher] ${item.target}: ошибка — ${res.error}`);
        } else if (res.skipped) {
          console.log(`[watcher] ${item.target}: пропущено (подозрительно пустое расписание)`);
        } else if (res.seeded) {
          console.log(`[watcher] ${item.target}: создан первичный снапшот`);
        } else if (res.hasChanges) {
          const dayCount = res.changesByDay?.length || 0;
          const changeCount = (res.changesByDay || []).reduce((acc, d) => acc + d.changes.length, 0);
          console.log(`[watcher] ${item.target}: изменения — дней ${dayCount}, правок ${changeCount}`);
          for (const day of res.changesByDay || []) {
            for (const c of day.changes) {
              console.log(`[watcher]   ${day.date} ${c.time} ${c.type}: ${c.subject} (${c.details})`);
            }
          }
        }

        await new Promise(resolve => setTimeout(resolve, 250));
      }

      const changed = results.filter(r => r.hasChanges).length;
      const failed = results.filter(r => r.success === false).length;
      const durationMs = Date.now() - startedAt;
      console.log(
        `[watcher] проверка завершена за ${durationMs} мс: целей ${results.length}, с изменениями ${changed}, ошибок ${failed}`
      );

      return results;
    } finally {
      this.isChecking = false;
    }
  }

  start(bot, intervalMinutes = 10) {
    if (this.timer) clearInterval(this.timer);

    const ms = Math.max(1, intervalMinutes) * 60 * 1000;

    setTimeout(() => {
      this.checkAll(bot).catch(err => {
        console.error('[watcher initial run error]:', err.message);
      });
    }, 5000);

    this.timer = setInterval(() => {
      this.checkAll(bot).catch(err => {
        console.error('[watcher interval run error]:', err.message);
      });
    }, ms);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const scheduleWatcher = new ScheduleWatcher();
