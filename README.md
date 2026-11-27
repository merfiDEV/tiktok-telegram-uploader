# tiktok-telegram-uploader

Автоматическая загрузка видео и нативных фото-постов в TikTok через браузер + Telegram-бот для пакетной отправки файлов и ссылок.

## Возможности

- Загрузка видео и фото/альбомов (до 35 изображений в одном посте).
- Описание, хэштеги, звуки из поиска или из избранного, задание времени публикации.
- Автоматическое решение капчи через Roboflow Inference.
- Несколько аккаунтов: куки хранятся отдельно в `TK_cookies_<аккаунт>.json`.
- Прокси, headless-режим, дополнительные «человеческие» задержки (`stealth`).
- Обход детекции ботов: Playwright + `playwright-extra` и плагин `puppeteer-extra-plugin-stealth`.
- Telegram-бот: очередь загрузки, live-доска статусов, пакетная заливка, загрузка по ссылкам через `yt-dlp`.

## Структура

```
tiktokautouploader/
  index.js          # публичные экспорты: uploadTiktok, uploadPhotos, TikTokUploadError
  function.js       # основная логика загрузки
  browser.js        # общий браузер со stealth-плагином
  login.js          # первичный вход в TikTok и сохранение кук
  userSimulator.js  # имитация действий пользователя
telegram_bot.js     # бот, очереди и кнопки
upload.js           # минимальный пример загрузки из CLI
Documentation.md    # подробности по параметрам и капче
```

## Требования

- Node.js 20.17+ (для флага `--env-file-if-exists`; на более старых версиях передавайте переменные через окружение и запускайте `node telegram_bot.js`).
- Chromium для Playwright:

  ```bash
  npx playwright install chromium
  ```

- Для загрузки по ссылкам в боте: `yt-dlp` и `ffmpeg`.

## Установка

```bash
npm install
```

## Первый вход в аккаунт

Имя аккаунта задаётся вами произвольно и используется как имя файла кук:

```bash
node upload.js ./video.mp4 "Моё описание" main test viral
```

При первом запуске откроется видимое окно браузера — войдите в TikTok вручную. Куки сохранятся в `TK_cookies_main.json` в текущей папке и будут использоваться дальше. Если куки истекут, вход повторится автоматически.

Файлы `TK_cookies_*.json`, `.env`, `downloads/` и `telegram_bot.log` игнорируются Git — не публикуйте их.

## Использование из Node.js

```js
const { uploadTiktok, uploadPhotos, TikTokUploadError } = require('./tiktokautouploader');

await uploadTiktok('video.mp4', 'Описание', 'main', {
  hashtags: ['fun', 'viral'],
  soundName: 'trending sound',
  soundAudVol: 'mix',
  schedule: '18:30',
  day: 27,
});

await uploadPhotos(['1.jpg', '2.png'], 'Описание', 'main', {
  title: 'Короткий заголовок',
  hashtags: ['fun'],
});
```

Обе функции возвращают `'Completed'` или `'Error'` и выбрасывают `TikTokUploadError` при ошибке.

### Параметры `uploadTiktok(video, description, accountname, options)`

| Параметр | Тип | Описание |
|---|---|---|
| `coverImage` | `string` | Обложка; изображение должно быть последним кадром видео |
| `hashtags` | `string[]` | Хэштеги с `#` или без |
| `soundName` | `string` | Название звука TikTok |
| `soundAudVol` | `string` | `mix`, `main` или `background` |
| `schedule` | `string` | Время публикации `HH:MM` (местное) |
| `day` | `number \| string` | Число месяца; только вместе с `schedule` |
| `copyrightcheck` | `boolean` | Проверка на авторские права перед публикацией |
| `visibility` | `string` | `everyone`, `friends` или `private` |
| `proxy` | `object` | `{ server: 'host:port', username, password }` |
| `searchMode` | `string` | `search` (поиск звука) или `favorites` |
| `headless` | `boolean` | Скрытое окно браузера |
| `stealth` | `boolean` | Дополнительные задержки между действиями |
| `suppressprint` | `boolean` | Не выводить прогресс в консоль |

### Параметры `uploadPhotos(photos, description, accountname, options)`

Поддерживаются `title` (до 90 символов), `hashtags`, `soundName`, `searchMode`, `schedule`, `day`, `visibility`, `proxy`, `headless`, `stealth` и `suppressprint`. `soundAudVol` принимается для совместимости, но на фото-посты не влияет.

## Telegram-бот

Создайте бота у [@BotFather](https://t.me/BotFather), затем создайте `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
TIKTOK_ACCOUNT=main
TIKTOK_HASHTAGS=#fyp,#viral
TELEGRAM_ALLOWED_CHAT_IDS=123456789
TELEGRAM_DOWNLOAD_DIR=./downloads
```

- `TELEGRAM_ALLOWED_CHAT_IDS` — id чатов через запятую; если не задано, бот открыт всем.
- `TIKTOK_ACCOUNT` — аккаунт по умолчанию, можно сменить командой `/account`.

Запуск:

```bash
npm run bot
```

Как пользоваться:

1. Пришлите видео (обычным сообщением или файлом) — оно встанет в очередь.
2. Пришлите фото или альбом — получится один нативный фото-пост.
3. Подпись к файлу становится описанием. Если файл без подписи, отправьте текст описания следующим сообщением — он привяжется к последнему файлу.
4. Пришлите ссылку (можно несколько с новых строк) — бот скачает её через `yt-dlp`. Формат с описанием: `https://... | мой текст`.
5. Нажмите «🚀 Залить на аккаунт» или «🚀 Залить все».

Команды:

| Команда | Действие |
|---|---|
| `/start`, `/help` | Справка |
| `/account [имя]` | Показать или сменить аккаунт |
| `/queue` | Живая доска очереди |
| `/list` | Список задач с описаниями |
| `/desc <№> <текст>` | Задать описание |
| `/upload <№>` | Залить одну задачу |
| `/uploadall` | Залить все готовые |
| `/remove <№>` | Удалить задачу |
| `/skip` | Пропустить ввод описания |
| `/cancel` | Отменить ввод описаний |

Ограничение Telegram для ботов — файлы до 20 МБ; большие видео присылайте ссылкой.

## Частые проблемы

- **Первый запуск для аккаунта открывает браузер.** Войдите в TikTok вручную — это нормально и требуется только один раз.
- **Куки просят входа снова.** Значит, сессия истекла; войдите в открывшемся окне.
- **`502 Bad Gateway` в логе polling.** Временная ошибка Telegram, библиотека сама повторяет запрос.
- **Капча.** Решается автоматически; при смене интерфейса TikTok может потребоваться обновить селекторы в `function.js`.

## Лицензия

MIT — см. [LICENSE.md](LICENSE.md).
