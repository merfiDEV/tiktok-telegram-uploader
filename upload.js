#!/usr/bin/env node
/**
 * Пример запуска:
 *   node upload.js ./video.mp4 "Описание" main test viral
 *
 * Первый запуск для каждого аккаунта открывает окно браузера для входа в TikTok
 * и сохраняет cookies в TK_cookies_<account>.json рядом с этим файлом.
 */

const { uploadTiktok, TikTokUploadError } = require('./tiktokautouploader');

const [video, description, accountname, ...hashtags] = process.argv.slice(2);

if (!video || !description || !accountname) {
  console.error('Usage: node upload.js <video> <description> <accountname> [#hashtag ...]');
  process.exit(1);
}

uploadTiktok(video, description, accountname, {
  hashtags: hashtags.length > 0 ? hashtags : null,
})
  .then((result) => {
    console.log('Result:', result);
  })
  .catch((error) => {
    if (error instanceof TikTokUploadError) {
      console.error(`${error.name}: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
