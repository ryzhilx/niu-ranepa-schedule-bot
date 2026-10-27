import 'dotenv/config';
import crypto from 'crypto';
import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import {
  search,
  getSchedule,
  getTodayDate,
  getTomorrowDate,
  getWeekRange,
  formatScheduleMessages,
  ScheduleSourceError
} from './api.js';
import { storage } from './storage.js';
import { directoryCache } from './cache.js';
import { scheduleWatcher } from './watcher.js';
import { dbManager } from './db.js';
import { refreshDirectoryIfNeeded } from './crawler.js';
import { makeRef, resolveRef } from './refs.js';
import { pending, PENDING_TARGET, PENDING_SEARCH } from './pendingState.js';

function resolveTarget(code) {
  const ref = resolveRef(code);
  return ref ? ref.value : code;
}

function scheduleUnavailableText() {
  return 'Сервис расписания временно недоступен, попробуйте позже.';
}

function describeScheduleError(err) {
  if (err instanceof ScheduleSourceError) {
    return scheduleUnavailableText();
  }
  return `Причина: ${err.message}`;
}

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('Не задан токен бота (BOT_TOKEN в файле .env)');
}

export const bot = new Bot(token || 'dummy_token');


function getProfileView(user) {
  const hasTarget = Boolean(user?.target);
  let text = '<b>Мой профиль</b>\n\n';

  if (hasTarget) {
    const notifStatus = user.notifications !== false ? 'Включены' : 'Отключены';
    text += `Текущая группа: <b>${user.target}</b>\n` +
      `Уведомления об изменениях: <b>${notifStatus}</b>`;
  } else {
    text += 'Основная группа пока не выбрана.\n' +
      'Выберите группу для быстрого доступа к расписанию и уведомлений.';
  }

  const keyboard = new InlineKeyboard();
  if (hasTarget) {
    const toggleBtnText = user.notifications !== false
      ? 'Отключить уведомления'
      : 'Включить уведомления';
    keyboard.text(toggleBtnText, 'toggle_notifications').row();
    keyboard.text('Изменить группу', 'profile_change_target');
  } else {
    keyboard.text('Выбрать группу', 'profile_change_target');
  }

  return { text, keyboard };
}

function getMainMenuKeyboard(hasTarget = false) {
  const keyboard = new Keyboard();
  if (hasTarget) {
    keyboard
      .text('На сегодня')
      .text('На завтра')
      .row()
      .text('На эту неделю')
      .text('На след. неделю')
      .row()
      .text('Поиск')
      .text('Мой профиль');
  } else {
    keyboard
      .text('Поиск');
  }
  return keyboard.resized();
}

function getScheduleInlineKeyboard(target, currentView = 'today') {
  const code = makeRef('target', target);
  const keyboard = new InlineKeyboard();
  keyboard
    .text('Сегодня', `view:today:${code}`)
    .text('Завтра', `view:tomorrow:${code}`)
    .row()
    .text('Эта неделя', `view:thisweek:${code}`)
    .text('След. неделя', `view:nextweek:${code}`)
    .row()
    .text('Обновить', `view:${currentView}:${code}`);
  return keyboard;
}

async function sendScheduleToUser(ctx, target, startDate, endDate, viewType = 'today') {
  const statusMsg = await ctx.reply('Загрузка расписания...');

  try {
    const scheduleResult = await getSchedule(target, startDate, endDate);
    const messages = formatScheduleMessages(scheduleResult);

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    for (let i = 0; i < messages.length; i++) {
      const isLast = i === messages.length - 1;
      await ctx.reply(messages[i], {
        parse_mode: 'HTML',
        reply_markup: isLast ? getScheduleInlineKeyboard(target, viewType) : undefined
      });
    }
  } catch (err) {
    console.error(`[getSchedule error for "${target}"]:`, err.message);
    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(
      `<b>Не удалось получить расписание</b>\n\n${describeScheduleError(err)}`,
      { parse_mode: 'HTML' }
    );
  }
}

bot.command('start', async (ctx) => {
  await storage.init();
  const user = storage.getUser(ctx.from.id);

  if (user?.target) {


    pending.clear(ctx.from.id);
    await ctx.reply(
      `Текущая группа: <b>${user.target}</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(true)
      }
    );
  } else {
    await ctx.reply(
      `Расписание <b>НИУ РАНХиГС</b>.\n\n` +
      `Отправьте название группы (например: <code>Гб-821</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(false)
      }
    );
  }
});

bot.callbackQuery(/^view:(today|tomorrow|thisweek|nextweek):(.+)$/, async (ctx) => {
  const viewType = ctx.match[1];
  const target = resolveTarget(ctx.match[2]);

  let startDate, endDate;
  if (viewType === 'today') {
    startDate = getTodayDate();
    endDate = startDate;
  } else if (viewType === 'tomorrow') {
    startDate = getTomorrowDate();
    endDate = startDate;
  } else if (viewType === 'thisweek') {
    const range = getWeekRange(new Date(), 0);
    startDate = range.start;
    endDate = range.finish;
  } else if (viewType === 'nextweek') {
    const range = getWeekRange(new Date(), 1);
    startDate = range.start;
    endDate = range.finish;
  }

  try {
    const scheduleResult = await getSchedule(target, startDate, endDate);
    const messages = formatScheduleMessages(scheduleResult);

    await ctx.answerCallbackQuery();

    if (messages.length === 1) {
      try {
        await ctx.editMessageText(messages[0], {
          parse_mode: 'HTML',
          reply_markup: getScheduleInlineKeyboard(target, viewType)
        });
      } catch (err) {
        if (!err.message?.includes('message is not modified')) throw err;
      }
      return;
    }



    await ctx.deleteMessage().catch(() => {});
    for (let i = 0; i < messages.length; i++) {
      const isLast = i === messages.length - 1;
      await ctx.reply(messages[i], {
        parse_mode: 'HTML',
        reply_markup: isLast ? getScheduleInlineKeyboard(target, viewType) : undefined
      });
    }
  } catch (err) {
    console.error(`[view callback error for "${target}"]:`, err.message);
    const text = err instanceof ScheduleSourceError ? 'Сервис расписания временно недоступен' : 'Ошибка обновления';
    await ctx.answerCallbackQuery({ text }).catch(() => {});
  }
});

bot.callbackQuery('toggle_notifications', async (ctx) => {
  await storage.init();
  const user = storage.getUser(ctx.from.id);
  if (!user) return ctx.answerCallbackQuery('Пользователь не найден');

  const newState = !user.notifications;
  await storage.setNotifications(ctx.from.id, newState);
  const updatedUser = storage.getUser(ctx.from.id);

  const { text: profileText, keyboard } = getProfileView(updatedUser);

  await ctx.editMessageText(profileText, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  }).catch(() => {});

  await ctx.answerCallbackQuery(newState ? 'Уведомления включены' : 'Уведомления отключены');
});

bot.callbackQuery('profile_change_target', async (ctx) => {

  pending.set(ctx.from.id, PENDING_TARGET);
  const cancelKeyboard = new InlineKeyboard().text('Отмена', 'profile_cancel_change');
  await ctx.reply(
    'Введите название группы (например: <code>Гб-821</code>):',
    {
      parse_mode: 'HTML',
      reply_markup: cancelKeyboard
    }
  );
});

bot.callbackQuery('profile_cancel_change', async (ctx) => {
  pending.clear(ctx.from.id);
  await ctx.answerCallbackQuery({ text: 'Отменено' });
  await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id).catch(() => {});
});

bot.callbackQuery(/^show:(.+):(.+)$/, async (ctx) => {
  const target = resolveTarget(ctx.match[2]);
  await ctx.answerCallbackQuery();
  const today = getTodayDate();
  await sendScheduleToUser(ctx, target, today, today, 'today');
});

bot.on('callback_query:data', async (ctx) => {
  await storage.init();
  const data = ctx.callbackQuery.data;

  if (data.startsWith('set_profile:') || data.startsWith('set:')) {
    const [, type, rawTarget] = data.split(':');
    const target = resolveTarget(rawTarget);
    if (type !== 'Group') {
      return ctx.answerCallbackQuery({
        text: 'В качестве профиля можно выбрать только учебную группу.',
        show_alert: true
      });
    }

    pending.clear(ctx.from.id);

    await storage.setUserTarget(ctx.from.id, target, 'Group');
    await scheduleWatcher.seedTarget(target);
    await ctx.answerCallbackQuery({ text: `Сохранено: ${target}` });

    await ctx.reply(
      `Основная группа сохранена: <b>${target}</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(true)
      }
    );

    const today = getTodayDate();
    await sendScheduleToUser(ctx, target, today, today, 'today');
  }
});

bot.on('inline_query', async (ctx) => {
  await storage.init();
  await directoryCache.init();
  const query = ctx.inlineQuery.query.trim();
  const user = storage.getUser(ctx.from.id);

  let targets = [];
  if (query.length > 0) {
    targets = (await search(query)).slice(0, 4);
  } else if (user?.target) {
    targets = [{ title: user.target, type: 'Group' }];
  }

  if (targets.length === 0) {
    return ctx.answerInlineQuery([], {
      cache_time: 5,
      switch_pm_text: 'Введите группу, преподавателя или аудиторию',
      switch_pm_parameter: 'search'
    });
  }

  const results = [];
  let sourceUnavailable = false;
  const today = getTodayDate();
  const week = getWeekRange(new Date(), 0);

  for (let idx = 0; idx < targets.length; idx++) {
    const t = targets[idx];
    const targetTitle = t.type === 'Aud'
      ? (t.id || t.title.replace(/^Ауд\.\s*/i, ''))
      : t.title;

    const labelPrefix = t.type === 'Prep'
      ? '[Преп.] '
      : (t.type === 'Aud' ? '[Ауд.] ' : '[Группа] ');

    try {
      const todaySched = await getSchedule(t.title, today, today);
      const todayMsgs = formatScheduleMessages(todaySched);

      results.push({
        type: 'article',
        id: crypto.createHash('md5').update(`today:${t.title}:${idx}`).digest('hex'),
        title: `${labelPrefix}${targetTitle} — сегодня`,
        description: `Расписание на ${today}`,
        input_message_content: {
          message_text: todayMsgs[0],
          parse_mode: 'HTML'
        }
      });

      const weekSched = await getSchedule(t.title, week.start, week.finish);
      const weekMsgs = formatScheduleMessages(weekSched);

      results.push({
        type: 'article',
        id: crypto.createHash('md5').update(`week:${t.title}:${idx}`).digest('hex'),
        title: `${labelPrefix}${targetTitle} — неделя`,
        description: `${week.start} — ${week.finish}`,
        input_message_content: {
          message_text: weekMsgs[0],
          parse_mode: 'HTML'
        }
      });
    } catch (err) {
      if (err instanceof ScheduleSourceError) {
        sourceUnavailable = true;
      }
      console.error(`[inline_query error for ${t.title}]:`, err.message);
    }
  }

  if (results.length === 0 && sourceUnavailable) {
    return ctx.answerInlineQuery([], {
      cache_time: 5,
      switch_pm_text: 'Сервис расписания временно недоступен, попробуйте позже',
      switch_pm_parameter: 'search'
    });
  }

  await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch(err => {
    console.error('[answerInlineQuery error]:', err.message);
  });
});

bot.on('message:text', async (ctx) => {
  await storage.init();
  const text = ctx.message.text.trim();
  const user = storage.getUser(ctx.from.id);

  if (text === 'На сегодня') {
    pending.clear(ctx.from.id);
    if (!user?.target) {
      return ctx.reply('Сначала укажите группу в профиле.');
    }
    const today = getTodayDate();
    return sendScheduleToUser(ctx, user.target, today, today, 'today');
  }

  if (text === 'На завтра') {
    pending.clear(ctx.from.id);
    if (!user?.target) {
      return ctx.reply('Сначала укажите группу в профиле.');
    }
    const tomorrow = getTomorrowDate();
    return sendScheduleToUser(ctx, user.target, tomorrow, tomorrow, 'tomorrow');
  }

  if (text === 'На эту неделю') {
    pending.clear(ctx.from.id);
    if (!user?.target) {
      return ctx.reply('Сначала укажите группу в профиле.');
    }
    const { start, finish } = getWeekRange(new Date(), 0);
    return sendScheduleToUser(ctx, user.target, start, finish, 'thisweek');
  }

  if (text === 'На след. неделю') {
    pending.clear(ctx.from.id);
    if (!user?.target) {
      return ctx.reply('Сначала укажите группу в профиле.');
    }
    const { start, finish } = getWeekRange(new Date(), 1);
    return sendScheduleToUser(ctx, user.target, start, finish, 'nextweek');
  }

  if (text === 'Поиск' || text === 'Найти / Сменить' || text === 'Найти группу или преподавателя' || text === 'Поиск аудитории') {
    pending.set(ctx.from.id, PENDING_SEARCH);
    return ctx.reply(
      'Введите название группы, фамилию преподавателя или номер аудитории (например: <code>Гб-821</code>, <code>Гаврилов</code> или <code>326</code>):',
      { parse_mode: 'HTML' }
    );
  }

  if (text === 'Мой профиль') {
    pending.clear(ctx.from.id);
    const { text: profileText, keyboard } = getProfileView(user);
    return ctx.reply(profileText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  const isChangingTarget = pending.is(ctx.from.id, PENDING_TARGET) || (!user?.target && !pending.is(ctx.from.id, PENDING_SEARCH));
  pending.clear(ctx.from.id);
  const statusMsg = await ctx.reply('Поиск...');

  try {
    const searchResults = await search(text);

    if (searchResults && searchResults.length > 0) {
      if (isChangingTarget) {
        const profileResults = searchResults.filter(item => item.type === 'Group');

        if (profileResults.length === 0 && searchResults.some(item => item.type === 'Aud' || item.type === 'Prep')) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          return ctx.reply(
            'В качестве профиля можно выбрать только учебную группу.\n\n' +
            'Введите название группы (например: <code>Гб-821</code>):',
            { parse_mode: 'HTML' }
          );
        }

        if (profileResults.length > 0) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          const inlineKeyboard = new InlineKeyboard();

          for (const item of profileResults.slice(0, 8)) {
            inlineKeyboard.text(`[Группа] ${item.title}`, `set_profile:Group:${makeRef('Group', item.title)}`).row();
          }

          return ctx.reply(
            `Найдено групп: <b>${profileResults.length}</b>. Выберите для сохранения в профиль:`,
            {
              parse_mode: 'HTML',
              reply_markup: inlineKeyboard
            }
          );
        }
      } else {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        const inlineKeyboard = new InlineKeyboard();

        for (const item of searchResults.slice(0, 8)) {
          const label = item.type === 'Aud'
            ? `[Ауд.] ${item.id || item.title.replace(/^Ауд\.\s*/i, '')}`
            : (item.type === 'Prep' ? `[Преп.] ${item.title}` : `[Группа] ${item.title}`);
          inlineKeyboard.text(label, `show:${item.type}:${makeRef(item.type, item.title)}`).row();
        }

        return ctx.reply(
          `Найдено совпадений: <b>${searchResults.length}</b>. Выберите вариант:`,
          {
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard
          }
        );
      }
    }

    const today = getTodayDate();
    const testRange = getWeekRange(new Date(), 0);
    const scheduleCheck = await getSchedule(text, testRange.start, testRange.finish);

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    if (scheduleCheck.targetType !== 'Unknown' || scheduleCheck.totalLessons > 0) {
      const type = scheduleCheck.targetType || 'Group';

      if (isChangingTarget) {
        if (type !== 'Group') {
          return ctx.reply(
            'В качестве профиля можно выбрать только учебную группу.\n\n' +
            'Введите название группы (например: <code>Гб-821</code>):',
            { parse_mode: 'HTML' }
          );
        }

        pending.clear(ctx.from.id);
        await storage.setUserTarget(ctx.from.id, text, 'Group');
        await scheduleWatcher.seedTarget(text);

        await ctx.reply(
          `Основная группа сохранена: <b>${text}</b>`,
          {
            parse_mode: 'HTML',
            reply_markup: getMainMenuKeyboard(true)
          }
        );
      }

      return sendScheduleToUser(ctx, text, today, today, 'today');
    }

    return ctx.reply(
      `По запросу «<b>${text}</b>» ничего не найдено.\n\n` +
      `Проверьте правильность написания группы (например: <code>Гб-821</code>), фамилии преподавателя или номера аудитории.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('[search/verification error]:', err.message);
    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    const text = err instanceof ScheduleSourceError
      ? scheduleUnavailableText()
      : `Ошибка: ${err.message}`;
    return ctx.reply(
      text,
      { reply_markup: getMainMenuKeyboard(Boolean(user?.target)) }
    );
  }
});

bot.catch((err) => {
  console.error('[bot error]:', err);
});

if (process.argv[1] && process.argv[1].endsWith('bot.js')) {
  if (!token || token === 'dummy_token') {
    console.error('Запуск невозможен: укажите BOT_TOKEN в файле .env');
    process.exit(1);
  }

  await storage.init();
  await bot.api.deleteMyCommands().catch(() => {});

  await directoryCache.init();

  const audCount = dbManager.db.prepare('SELECT count(*) as count FROM auditorium_lessons').get().count;
  console.log('Обновление официального справочника...');
  await refreshDirectoryIfNeeded({ syncAuditoria: audCount === 0 })
    .catch(err => console.error('Ошибка обновления справочника:', err.message));

  await scheduleWatcher.init();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Получен ${signal}, останавливаемся...`);
    try {
      scheduleWatcher.stop();
      await bot.stop().catch(() => {});
    } finally {
      try { dbManager.db.close(); } catch {}
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('Запуск Telegram-бота...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`Бот @${botInfo.username} запущен.`);
      const parsed = parseInt(process.env.CHECK_INTERVAL_MINUTES, 10);
      const intervalMin = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
      scheduleWatcher.start(bot, intervalMin);
    }
  });
}
