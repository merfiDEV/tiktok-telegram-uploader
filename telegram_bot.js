#!/usr/bin/env node
/**
 * Telegram-бот для пакетной загрузки видео в TikTok.
 *
 * Возможности:
 *  - присылаете одно или несколько видео (файлом или как видео) — они встают в очередь;
 *  - подпись к видео сразу становится описанием, описание можно поменять кнопкой «✏️ Описание»;
 *  - присылаете ссылку — бот скачивает видео через yt-dlp и предлагает залить его на аккаунт;
 *  - «🚀 Залить все» отправляет на TikTok все готовые видео по очереди (одно за другим).
 *
 * Запуск (из корня репозитория, там же где upload.js):
 *   TELEGRAM_BOT_TOKEN=123:ABC TIKTOK_ACCOUNT=main node telegram_bot.js
 *
 * Переменные окружения:
 *   TELEGRAM_BOT_TOKEN          — токен бота от @BotFather (обязательно)
 *   TIKTOK_ACCOUNT              — имя аккаунта по умолчанию (можно задать командой /account)
 *   TIKTOK_HASHTAGS             — хэштеги по умолчанию, через запятую/пробел: "#fyp,#viral"
 *   TELEGRAM_ALLOWED_CHAT_IDS   — id разрешённых чатов через запятую (если не задано — бот открыт всем)
 *   TELEGRAM_DOWNLOAD_DIR       — папка для скачанных видео (по умолчанию ./downloads)
 *
 * Для ссылок нужен установленный yt-dlp (и ffmpeg для склейки видео/звука).
 * Телеграм отдаёт ботам файлы только до 20 МБ — большие видео присылайте ссылкой.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');

const { uploadTiktok, TikTokUploadError } = require('./tiktokautouploader');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Не задан TELEGRAM_BOT_TOKEN. Получите токен у @BotFather и запустите:');
  console.error('  TELEGRAM_BOT_TOKEN=123:ABC TIKTOK_ACCOUNT=main node telegram_bot.js');
  process.exit(1);
}

const DOWNLOAD_DIR =
  process.env.TELEGRAM_DOWNLOAD_DIR || path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const ALLOWED_CHATS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const DEFAULT_HASHTAGS = (process.env.TIKTOK_HASHTAGS || '')
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const MAX_DESCRIPTION_LENGTH = 2200;
const LINK_RE = /https?:\/\/[^\s<>"']+/gi;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const bot = new TelegramBot(TOKEN, { polling: true });

let account = process.env.TIKTOK_ACCOUNT || '';
let hashtags = DEFAULT_HASHTAGS;

/** @type {Map<number, {id:number, chatId:number, file:string, description:string, status:string}>} */
const tasks = new Map();
let nextTaskId = 1;

/** chatId -> id задачи, для которой ждём текст описания */
const awaitingDescription = new Map();

/** chatId -> очередь задач, для которых ещё нужно спросить описание */
const descriptionQueues = new Map();

const uploadQueue = [];
let workerRunning = false;

const STATUS_LABELS = {
  waiting: '⏳ ждёт скачивания',
  downloading: '⬇️ скачивается',
  ready: '✅ готово к заливке',
  queued: '🕓 в очереди на заливку',
  uploading: '🚀 заливается',
  done: '📤 залито',
  failed: '❌ ошибка',
};

/** chatId -> { messageId, timer, rendering, needsRender } для живого сообщения «Очередь» */
const boardState = new Map();

function isAllowed(chatId) {
  return ALLOWED_CHATS.length === 0 || ALLOWED_CHATS.includes(String(chatId));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function addTask(chatId, { file = null, label = '', description = '', status = 'ready' }) {
  const task = {
    id: nextTaskId++,
    chatId,
    file,
    label,
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    status,
    error: '',
  };
  tasks.set(task.id, task);
  return task;
}

function taskName(task) {
  if (task.file) return path.basename(task.file);
  return task.label || 'видео';
}

function taskCard(task) {
  const description = task.description
    ? task.description.length > 300
      ? `${task.description.slice(0, 300)}…`
      : task.description
    : '— не задано';

  return (
    `🎬 <b>#${task.id}</b> · ${STATUS_LABELS[task.status] || task.status}\n` +
    `Файл: <code>${escapeHtml(taskName(task))}</code>\n` +
    `Описание: ${escapeHtml(description)}`
  );
}

function taskKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: '✏️ Описание', callback_data: `desc:${taskId}` },
        { text: '🚀 Залить на аккаунт', callback_data: `up:${taskId}` },
      ],
      [
        { text: '🚀 Залить все', callback_data: 'upall' },
        { text: '🗑 Удалить', callback_data: `del:${taskId}` },
      ],
    ],
  };
}

async function sendTaskCard(chatId, task) {
  await bot.sendMessage(chatId, taskCard(task), {
    parse_mode: 'HTML',
    reply_markup: taskKeyboard(task.id),
  });
}

function shortText(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Текст живого сообщения «Очередь»: что качается, что ждёт и что заливается. */
function boardText(chatId) {
  const chatTasks = [...tasks.values()].filter((task) => task.chatId === chatId);
  if (chatTasks.length === 0) return null;

  const active = chatTasks.filter((task) => task.status !== 'done');
  const counts = {};
  for (const task of active) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }

  const summary = Object.entries(STATUS_LABELS)
    .filter(([status]) => counts[status])
    .map(([status, label]) => `${label}: ${counts[status]}`)
    .join(' · ');

  const shown = chatTasks.slice(-15);
  const hidden = chatTasks.length - shown.length;

  let text = '📋 <b>Очередь</b>\n';
  text += summary ? `${summary}\n` : 'Все задачи завершены.\n';
  if (hidden > 0) text += `… ещё ${hidden} раньше\n`;

  for (const task of shown) {
    text += `\n${STATUS_LABELS[task.status] || task.status} · #${task.id} · ${escapeHtml(
      shortText(taskName(task), 60)
    )}`;
    if (task.status === 'queued') {
      const position = uploadQueue.findIndex((queued) => queued.id === task.id);
      if (position >= 0) text += ` (${position + 1}-й в очереди)`;
    }
    if (task.status === 'failed' && task.error) {
      text += `\n   ↳ ${escapeHtml(shortText(task.error, 120))}`;
    }
  }

  return text;
}

async function renderBoard(chatId) {
  let state = boardState.get(chatId);
  if (!state) {
    state = { messageId: null, timer: null, rendering: false, needsRender: false };
    boardState.set(chatId, state);
  }
  if (state.rendering) {
    state.needsRender = true;
    return;
  }

  state.rendering = true;
  try {
    do {
      state.needsRender = false;
      const text = boardText(chatId);
      if (!text) return;

      if (state.messageId) {
        try {
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: state.messageId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
          continue;
        } catch (error) {
          if (/message is not modified/i.test(error.message)) continue;
          // Сообщение удалили или оно слишком старое — пришлём новое.
          state.messageId = null;
        }
      }

      const sent = await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      state.messageId = sent.message_id;
    } while (state.needsRender);
  } finally {
    state.rendering = false;
  }

  if (state.needsRender) scheduleBoardUpdate(chatId);
}

/** Обновляет «Очередь» с задержкой, чтобы не упираться в лимиты Telegram. */
function scheduleBoardUpdate(chatId) {
  let state = boardState.get(chatId);
  if (!state) {
    state = { messageId: null, timer: null, rendering: false, needsRender: false };
    boardState.set(chatId, state);
  }
  if (state.timer) return;

  state.timer = setTimeout(() => {
    state.timer = null;
    renderBoard(chatId).catch((error) =>
      console.error('Ошибка обновления очереди:', error.message)
    );
  }, 1200);
}

/** Скачивает файл из Telegram (лимит бота — 20 МБ). */
async function downloadTelegramFile(fileId, extension) {
  const link = await bot.getFileLink(fileId);
  const dest = path.join(
    DOWNLOAD_DIR,
    `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`
  );

  const response = await fetch(link);
  if (!response.ok) {
    throw new Error(`Telegram вернул ${response.status} при скачивании файла`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return dest;
}

/** Скачивает видео по ссылке через yt-dlp и возвращает путь к файлу. */
function downloadFromLink(url) {
  return new Promise((resolve, reject) => {
    // Своя папка на каждое скачивание: имя файла остаётся читаемым (заголовок видео).
    const targetDir = path.join(
      DOWNLOAD_DIR,
      `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    fs.mkdirSync(targetDir, { recursive: true });
    const outputTemplate = path.join(targetDir, '%(title).60B-[%(id)s].%(ext)s');
    const child = spawn(
      'yt-dlp',
      [
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--restrict-filenames',
        '-f',
        'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b/best',
        '--print',
        'after_move:filepath',
        '-o',
        outputTemplate,
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('yt-dlp не уложился в 15 минут'));
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new Error('yt-dlp не найден, установите его: pip install -U yt-dlp')
          : error
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        const reason =
          stderr
            .trim()
            .split('\n')
            .filter(Boolean)
            .pop() || `yt-dlp завершился с кодом ${code}`;
        reject(new Error(reason));
        return;
      }

      const file = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();

      if (!file || !fs.existsSync(file)) {
        reject(new Error('yt-dlp не сообщил путь к скачанному файлу'));
        return;
      }

      resolve(file);
    });
  });
}

function removeFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    /* файл уже удалён или занят — не критично */
  }

  try {
    const dir = path.dirname(file);
    if (dir !== DOWNLOAD_DIR && dir.startsWith(DOWNLOAD_DIR)) {
      fs.rmdirSync(dir);
    }
  } catch (error) {
    /* папка не пуста или уже удалена */
  }
}

function enqueueTask(task) {
  if (!tasks.has(task.id)) return;
  if (task.status === 'queued' || task.status === 'uploading' || task.status === 'done') {
    return;
  }
  if (!account) {
    bot.sendMessage(
      task.chatId,
      '⚠️ Сначала задайте аккаунт: /account имя_аккаунта (имя должно совпадать с TK_cookies_<имя>.json)'
    );
    return;
  }
  task.status = 'queued';
  uploadQueue.push(task);
  scheduleBoardUpdate(task.chatId);
  runWorker();
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (uploadQueue.length > 0) {
      const task = uploadQueue.shift();
      if (!tasks.has(task.id) || task.status !== 'queued') continue;

      task.status = 'uploading';
      scheduleBoardUpdate(task.chatId);
      try {
        await bot.sendMessage(
          task.chatId,
          `🚀 Заливаю #${task.id} на аккаунт «${escapeHtml(account)}»…`,
          { parse_mode: 'HTML' }
        );

        const result = await uploadTiktok(task.file, task.description, account, {
          hashtags: hashtags.length > 0 ? hashtags : null,
        });

        if (result !== 'Completed') {
          throw new Error(`uploadTiktok вернул «${result}»`);
        }

        task.status = 'done';
        scheduleBoardUpdate(task.chatId);
        await bot.sendMessage(task.chatId, `✅ #${task.id} успешно залито на аккаунт «${account}».`);
        removeFile(task.file);
        task.file = null;
      } catch (error) {
        task.status = 'failed';
        task.error =
          error instanceof TikTokUploadError ? error.message : error.message || String(error);
        scheduleBoardUpdate(task.chatId);
        await bot.sendMessage(task.chatId, `❌ Не удалось залить #${task.id}: ${task.error}`);
      }
    }
  } finally {
    workerRunning = false;
  }
}

async function handleVideoMessage(msg) {
  const chatId = msg.chat.id;
  const media = msg.video || msg.document;

  let extension = '.mp4';
  if (msg.document && msg.document.file_name) {
    const parsed = path.extname(msg.document.file_name).toLowerCase();
    if (VIDEO_EXTENSIONS.has(parsed)) extension = parsed;
  }

  // Задача появляется в «Очереди» сразу, ещё до окончания скачивания.
  const task = addTask(chatId, {
    description: msg.caption || '',
    status: 'downloading',
    label: msg.document?.file_name || 'видео из Telegram',
  });
  scheduleBoardUpdate(chatId);

  try {
    // В альбоме сообщений много — не засоряем чат отдельным статусом на каждое.
    if (!msg.media_group_id) {
      await bot.sendMessage(chatId, `⬇️ Скачиваю #${task.id}…`);
    }
    const file = await downloadTelegramFile(media.file_id, extension);
    task.file = file;
    task.status = 'ready';
    scheduleBoardUpdate(chatId);
    await sendTaskCard(chatId, task);
  } catch (error) {
    task.status = 'failed';
    task.error = error.message;
    scheduleBoardUpdate(chatId);
    await bot.sendMessage(
      chatId,
      `❌ Не удалось скачать #${task.id}: ${error.message}\n` +
        'Телеграм отдаёт ботам файлы до 20 МБ — большое видео пришлите ссылкой.'
    );
  }
}

/** Разбирает текст на пары «ссылка | описание» (описание необязательно). */
function parseLinkEntries(text) {
  const entries = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const links = line.match(LINK_RE) || [];
    if (links.length === 0) continue;

    const pipeIndex = line.indexOf('|');
    const description = pipeIndex === -1 ? '' : line.slice(pipeIndex + 1).trim();

    links.forEach((link) => {
      entries.push({
        link,
        description: links.length === 1 ? description : '',
      });
    });
  }

  return entries;
}

/** Спрашивает описание для следующего видео из очереди. */
async function askNextDescription(chatId) {
  const queue = descriptionQueues.get(chatId) || [];

  while (queue.length > 0) {
    const taskId = queue.shift();
    const task = tasks.get(taskId);

    if (!task || task.chatId !== chatId || task.description) continue;

    descriptionQueues.set(chatId, queue);
    awaitingDescription.set(chatId, task.id);
    await bot.sendMessage(
      chatId,
      `✏️ Описание для #${task.id}: ${path.basename(task.file)}\n` +
        'Отправьте текст описания или /skip, чтобы пропустить.'
    );
    return;
  }

  descriptionQueues.delete(chatId);
}

async function handleLinkBatch(chatId, entries) {
  // Все ссылки сразу становятся задачами «⏳ ждёт скачивания» — видно весь список.
  const created = entries.map(({ link, description }) =>
    addTask(chatId, { description, status: 'waiting', label: link })
  );

  await bot.sendMessage(
    chatId,
    `📥 В очереди на скачивание: ${created.length}. Статусы — в сообщении «Очередь».`
  );
  scheduleBoardUpdate(chatId);

  const failed = [];

  for (const task of created) {
    if (!tasks.has(task.id)) continue; // задачу успели удалить

    task.status = 'downloading';
    scheduleBoardUpdate(chatId);

    try {
      const file = await downloadFromLink(task.label);
      task.file = file;
      task.status = 'ready';
      scheduleBoardUpdate(chatId);
      await sendTaskCard(chatId, task);
    } catch (error) {
      task.status = 'failed';
      task.error = error.message;
      failed.push(`• ${task.label}\n  ${error.message}`);
      scheduleBoardUpdate(chatId);
    }
  }

  if (failed.length > 0) {
    await bot.sendMessage(chatId, `❌ Не удалось скачать:\n${failed.join('\n')}`);
  }

  const needDescription = created
    .filter((task) => tasks.has(task.id) && task.status === 'ready' && !task.description)
    .map((task) => task.id);

  if (needDescription.length > 0) {
    descriptionQueues.set(chatId, needDescription);
    await askNextDescription(chatId);
  }
}

function helpText() {
  return (
    '📚 <b>Как пользоваться</b>\n\n' +
    '1. Пришлите одно или несколько видео (обычным видео или файлом).\n' +
    '2. Пришлите одну или несколько ссылок — каждую с новой строки. Бот скачает всё пачкой и по очереди предложит описание для каждого видео.\n' +
    '3. Подпись к видео или текст после «|» в строке со ссылкой сразу станет описанием:\n' +
    '    <code>https://... | мое описание</code>\n' +
    '4. Нажмите «🚀 Залить на аккаунт» для одного видео или «🚀 Залить все» для всей пачки.\n\n' +
    '<b>Команды</b>\n' +
    '/queue — показать очередь скачивания и заливки\n' +
    '/list — список видео и описаний\n' +
    '/desc &lt;номер&gt; &lt;текст&gt; — задать описание\n' +
    '/upload &lt;номер&gt; — залить одно видео\n' +
    '/uploadall — залить все готовые\n' +
    '/remove &lt;номер&gt; — убрать из очереди\n' +
    '/skip — пропустить описание текущего видео\n' +
    '/account — показать аккаунт\n' +
    '/account &lt;имя&gt; — сменить аккаунт\n' +
    '/cancel — отменить ввод описаний\n\n' +
    `Текущий аккаунт: <b>${account ? escapeHtml(account) : 'не задан'}</b>\n` +
    `Хэштеги: ${hashtags.length > 0 ? escapeHtml(hashtags.join(' ')) : 'нет'}`
  );
}

async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const command = text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase();
  const args = text.replace(/^\/\S+(?:\s+|$)/, '').trim();

  switch (command) {
    case '/start':
    case '/help':
      await bot.sendMessage(chatId, helpText(), { parse_mode: 'HTML' });
      return;

    case '/account': {
      if (!args) {
        await bot.sendMessage(
          chatId,
          account ? `Текущий аккаунт: ${account}` : 'Аккаунт не задан. Используйте /account имя_аккаунта'
        );
        return;
      }
      account = args;
      await bot.sendMessage(chatId, `✅ Аккаунт: ${account}`);
      return;
    }

    case '/queue': {
      const chatTasks = [...tasks.values()].filter((task) => task.chatId === chatId);
      if (chatTasks.length === 0) {
        await bot.sendMessage(chatId, 'Очередь пуста. Пришлите видео или ссылку.');
        return;
      }
      await renderBoard(chatId);
      const state = boardState.get(chatId);
      if (state && !state.messageId) {
        await bot.sendMessage(chatId, 'Не удалось отправить сообщение очереди, попробуйте ещё раз.');
      }
      return;
    }

    case '/list': {
      const chatTasks = [...tasks.values()].filter((task) => task.chatId === chatId);
      if (chatTasks.length === 0) {
        await bot.sendMessage(chatId, 'Очередь пуста. Пришлите видео или ссылку.');
        return;
      }
      // Telegram ограничивает сообщение 4096 символами — отправляем частями.
      let chunk = '';
      for (const line of chatTasks.map((task) => taskCard(task))) {
        if (chunk && chunk.length + line.length + 2 > 4000) {
          await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
          chunk = '';
        }
        chunk += (chunk ? '\n\n' : '') + line;
      }
      if (chunk) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      }
      return;
    }

    case '/desc': {
      const match = text.match(/^\/desc(?:@\w+)?\s+(\d+)\s*([\s\S]*)$/i);
      if (!match) {
        await bot.sendMessage(chatId, 'Формат: /desc 1 текст описания');
        return;
      }
      const task = tasks.get(Number(match[1]));
      if (!task || task.chatId !== chatId) {
        await bot.sendMessage(chatId, `Видео #${match[1]} не найдено.`);
        return;
      }
      const description = match[2].trim();
      if (!description) {
        const queue = descriptionQueues.get(chatId);
        if (queue) {
          descriptionQueues.set(
            chatId,
            queue.filter((id) => id !== task.id)
          );
        }
        awaitingDescription.set(chatId, task.id);
        await bot.sendMessage(chatId, `Отправьте текст описания для #${task.id} (или /cancel).`);
        return;
      }
      task.description = description.slice(0, MAX_DESCRIPTION_LENGTH);
      await bot.sendMessage(chatId, `✅ Описание для #${task.id} сохранено.`);
      await sendTaskCard(chatId, task);
      await askNextDescription(chatId);
      return;
    }

    case '/upload': {
      const ids = args
        .match(/\d+/g)
        ?.map(Number);
      if (!ids || ids.length === 0) {
        await bot.sendMessage(chatId, 'Формат: /upload 1 (или /uploadall для всей пачки)');
        return;
      }
      for (const id of ids) {
        const task = tasks.get(id);
        if (!task || task.chatId !== chatId) {
          await bot.sendMessage(chatId, `Видео #${id} не найдено.`);
          continue;
        }
        enqueueTask(task);
      }
      return;
    }

    case '/uploadall': {
      const ready = [...tasks.values()].filter(
        (task) => task.chatId === chatId && task.status === 'ready'
      );
      if (ready.length === 0) {
        await bot.sendMessage(chatId, 'Нет готовых к заливке видео.');
        return;
      }
      for (const task of ready) enqueueTask(task);
      return;
    }

    case '/remove': {
      const id = Number((args.match(/\d+/) || [])[0]);
      const task = tasks.get(id);
      if (!task || task.chatId !== chatId) {
        await bot.sendMessage(chatId, 'Формат: /remove 1');
        return;
      }
      if (task.status === 'uploading') {
        await bot.sendMessage(chatId, 'Это видео уже заливается, дождитесь окончания.');
        return;
      }
      tasks.delete(id);
      removeFile(task.file);
      scheduleBoardUpdate(chatId);
      await bot.sendMessage(chatId, `🗑 #${id} удалено.`);
      return;
    }

    case '/skip':
      if (!awaitingDescription.has(chatId)) {
        await bot.sendMessage(chatId, 'Сейчас нет запроса описания.');
        return;
      }
      awaitingDescription.delete(chatId);
      await bot.sendMessage(chatId, '⏭ Пропустил это видео.');
      await askNextDescription(chatId);
      return;

    case '/cancel':
      awaitingDescription.delete(chatId);
      descriptionQueues.delete(chatId);
      await bot.sendMessage(chatId, 'Ок, ввод описаний отменён.');
      return;

    default:
      await bot.sendMessage(chatId, 'Неизвестная команда. Список команд: /help');
  }
}

bot.on('message', async (msg) => {
  if (!msg.chat || !isAllowed(msg.chat.id)) return;
  const chatId = msg.chat.id;

  try {
    if (msg.video || (msg.document && isVideoDocument(msg.document))) {
      await handleVideoMessage(msg);
      return;
    }

    if (!msg.text) return;

    if (msg.text.startsWith('/')) {
      await handleCommand(msg);
      return;
    }

    if (awaitingDescription.has(chatId)) {
      const taskId = awaitingDescription.get(chatId);
      awaitingDescription.delete(chatId);
      const task = tasks.get(taskId);

      if (!task) {
        await bot.sendMessage(chatId, 'Видео уже удалено, описание не сохранено.');
        await askNextDescription(chatId);
        return;
      }

      task.description = msg.text.trim().slice(0, MAX_DESCRIPTION_LENGTH);
      await bot.sendMessage(chatId, `✅ Описание для #${task.id} сохранено.`);
      await sendTaskCard(chatId, task);
      await askNextDescription(chatId);
      return;
    }

    const entries = parseLinkEntries(msg.text);
    if (entries.length > 0) {
      await handleLinkBatch(chatId, entries);
      return;
    }

    await bot.sendMessage(chatId, 'Пришлите видео, ссылку или /help.');
  } catch (error) {
    console.error('Ошибка обработки сообщения:', error);
    await bot.sendMessage(chatId, `❌ Внутренняя ошибка: ${error.message}`);
  }
});

function isVideoDocument(document) {
  if (!document) return false;
  if (document.mime_type && document.mime_type.startsWith('video/')) return true;
  const extension = path.extname(document.file_name || '').toLowerCase();
  return VIDEO_EXTENSIONS.has(extension);
}

bot.on('callback_query', async (query) => {
  const message = query.message;
  if (!message || !message.chat || !isAllowed(message.chat.id)) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  const chatId = message.chat.id;
  const [action, rawId] = (query.data || '').split(':');
  const taskId = Number(rawId);

  try {
    if (action === 'desc') {
      const task = tasks.get(taskId);
      if (!task || task.chatId !== chatId) {
        await bot.answerCallbackQuery(query.id, { text: 'Видео не найдено' });
        return;
      }
      awaitingDescription.set(chatId, task.id);
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        `✏️ Описание для #${task.id}: ${path.basename(task.file)}\n` +
          'Отправьте текст описания или /skip, чтобы пропустить.'
      );
      return;
    }

    if (action === 'up') {
      const task = tasks.get(taskId);
      if (!task || task.chatId !== chatId) {
        await bot.answerCallbackQuery(query.id, { text: 'Видео не найдено' });
        return;
      }
      await bot.answerCallbackQuery(query.id);
      enqueueTask(task);
      return;
    }

    if (action === 'upall') {
      const ready = [...tasks.values()].filter(
        (task) => task.chatId === chatId && task.status === 'ready'
      );
      await bot.answerCallbackQuery(query.id);
      if (ready.length === 0) {
        await bot.sendMessage(chatId, 'Нет готовых к заливке видео.');
        return;
      }
      for (const task of ready) enqueueTask(task);
      return;
    }

    if (action === 'del') {
      const task = tasks.get(taskId);
      if (!task || task.chatId !== chatId) {
        await bot.answerCallbackQuery(query.id, { text: 'Видео не найдено' });
        return;
      }
      if (task.status === 'uploading') {
        await bot.answerCallbackQuery(query.id, { text: 'Видео уже заливается' });
        return;
      }
      tasks.delete(task.id);
      removeFile(task.file);
      scheduleBoardUpdate(chatId);
      await bot.answerCallbackQuery(query.id, { text: 'Удалено' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: message.message_id }
      );
      await bot.sendMessage(chatId, `🗑 #${task.id} удалено.`);
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Ошибка обработки кнопки:', error);
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Ошибка, попробуйте ещё раз' });
    } catch (e) {
      /* callback уже истёк */
    }
  }
});

bot.on('polling_error', (error) => {
  console.error('Ошибка Telegram polling:', error.message);
});

console.log('Telegram-бот запущен.');
console.log(`Аккаунт: ${account || 'не задан (/account <имя>)'}`);
if (ALLOWED_CHATS.length > 0) {
  console.log(`Разрешённые чаты: ${ALLOWED_CHATS.join(', ')}`);
}
