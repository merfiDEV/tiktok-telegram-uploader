/**
 * Core TikTok upload automation.
 *
 * One-to-one JavaScript port of the Python `tiktokautouploader/function.py`.
 * The browser engine is Playwright + puppeteer-extra stealth (the same stack
 * the Python version drove through its Node.js login asset), and the upload
 * flow, selectors, error messages and return values are kept identical.
 */

const fs = require('fs');
const https = require('https');

const { HttpsProxyAgent } = require('https-proxy-agent');

const { chromium } = require('./browser');
const { UserSimulator } = require('./userSimulator');
const { login } = require('./login');

class TikTokUploadError extends Error {
  /**
   * Raised when a TikTok upload fails or cannot be confirmed.
   *
   * Mirrors the Python `TikTokUploadError` so callers can catch upload
   * failures without the process exiting.
   */
  constructor(message) {
    super(message);
    this.name = 'TikTokUploadError';
  }
}

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload&lang=en';
const DRAFT_URL = 'https://www.tiktok.com/tiktokstudio/content?tab=draft';
const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';

const CAPTCHA_QUESTION_SELECTOR = 'div.VerifyBar___StyledDiv-sc-12zaxoy-0.hRJhHT';
const CAPTCHA_IMAGE_SELECTOR = 'img#captcha-verify-image';
const CAPTCHA_REFRESH_SELECTOR = 'span.secsdk_captcha_refresh--text';
const CAPTCHA_SUCCESS_SELECTOR = 'div.captcha_verify_message.captcha_verify_message-pass';
const CAPTCHA_FAIL_SELECTOR = 'div.captcha_verify_message.captcha_verify_message-fail';
const CAPTCHA_SUBMIT_SELECTOR = 'div.verify-captcha-submit-button';

const SCHEDULE_DAY_ICON_SELECTOR =
  'div.TUXTextInputCore-leadingIconWrapper:has(svg > path[d="M15 3a1 1 0 0 0-1 1v3h-1.4c-3.36 0-5.04 0-6.32.65a6 6 0 0 0-2.63 2.63C3 11.56 3 13.24 3 16.6v16.8c0 3.36 0 5.04.65 6.32a6 6 0 0 0 2.63 2.63c1.28.65 2.96.65 6.32.65h22.8c3.36 0 5.04 0 6.32-.65a6 6 0 0 0 2.63-2.63c.65-1.28.65-2.96.65-6.32V16.6c0-3.36 0-5.04-.65-6.32a6 6 0 0 0-2.63-2.63C40.44 7 38.76 7 35.4 7H34V4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3H18V4a1 1 0 0 0-1-1h-2Zm-2.4 8H14v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3h12v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3h1.4c1.75 0 2.82 0 3.62.07a5.11 5.11 0 0 1 .86.14h.03a2 2 0 0 1 .88.91 5.11 5.11 0 0 1 .14.86c.07.8.07 1.87.07 3.62v1.9H7v-1.9c0-1.75 0-2.82.07-3.62a5.12 5.12 0 0 1 .14-.86v-.03a2 2 0 0 1 .88-.87l.03-.01a5.11 5.11 0 0 1 .86-.14c.8-.07 1.87-.07 3.62-.07ZM7 22.5h34v10.9c0 1.75 0 2.82-.07 3.62a5.11 5.11 0 0 1-.14.86v.03a2 2 0 0 1-.88.87l-.03.01a5.11 5.11 0 0 1-.86.14c-.8.07-1.87.07-3.62.07H12.6c-1.75 0-2.82 0-3.62-.07a5.11 5.11 0 0 1-.89-.15 2 2 0 0 1-.87-.87l-.01-.03a5.12 5.12 0 0 1-.14-.86C7 36.22 7 35.15 7 33.4V22.5Z"])';
const SCHEDULE_TIME_ICON_SELECTOR =
  'div.TUXTextInputCore-leadingIconWrapper:has(svg > path[d="M24 2a22 22 0 1 0 0 44 22 22 0 0 0 0-44ZM6 24a18 18 0 1 1 36 0 18 18 0 0 1-36 0Z"])';

const SOUND_VOLUME_ICON_WAIT_SELECTOR =
  'img[src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjEiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMSAyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTAgNy41MDE2QzAgNi42NzMxNyAwLjY3MTU3MyA2LjAwMTYgMS41IDYuMDAxNkgzLjU3NzA5QzMuODY4MDUgNi4wMDE2IDQuMTQ0NTggNS44NzQ4OCA0LjMzNDU1IDUuNjU0NDlMOC43NDI1NSAwLjU0MDUyQzkuMzQ3OCAtMC4xNjE2NjggMTAuNSAwLjI2NjM3NCAxMC41IDEuMTkzNDFWMTguOTY3MkMxMC41IDE5Ljg3NDUgOS4zODg5NCAyMC4zMTI5IDguNzY5NDIgMTkuNjVMNC4zMzE3OSAxNC45MDIxQzQuMTQyNjkgMTQuNjk5OCAzLjg3ODE2IDE0LjU4NDkgMy42MDEyMiAxNC41ODQ5SDEuNUMwLjY3MTU3MyAxNC41ODQ5IDAgMTMuOTEzNCAwIDEzLjA4NDlWNy41MDE2Wk01Ljg0OTQ1IDYuOTYwMjdDNS4yNzk1NiA3LjYyMTQzIDQuNDQ5OTcgOC4wMDE2IDMuNTc3MDkgOC4wMDE2SDJWMTIuNTg0OUgzLjYwMTIyQzQuNDMyMDMgMTIuNTg0OSA1LjIyNTY0IDEyLjkyOTUgNS43OTI5NSAxMy41MzY0TDguNSAxNi40MzI4VjMuODg1MjJMNS44NDk0NSA2Ljk2MDI3WiIgZmlsbD0iIzE2MTgyMyIgZmlsbC1vcGFjaXR5PSIwLjYiLz4KPHBhdGggZD0iTTEzLjUxNSA3LjE5MTE5QzEzLjM0MjQgNi45NzU1OSAxMy4zMzk5IDYuNjYwNTYgMTMuNTM1MiA2LjQ2NTNMMTQuMjQyMyA1Ljc1ODE5QzE0LjQzNzYgNS41NjI5MyAxNC43NTU4IDUuNTYxNzUgMTQuOTM1NiA1Ljc3MTM2QzE2Ljk5NTkgOC4xNzM2MiAxNi45OTU5IDExLjgyOCAxNC45MzU2IDE0LjIzMDNDMTQuNzU1OCAxNC40Mzk5IDE0LjQzNzYgMTQuNDM4NyAxNC4yNDIzIDE0LjI0MzVMMTMuNTM1MiAxMy41MzY0QzEzLjMzOTkgMTMuMzQxMSAxMy4zNDI0IDEzLjAyNjEgMTMuNTE1IDEyLjgxMDVDMTQuODEzIDExLjE4ODUgMTQuODEzIDguODEzMTIgMTMuNTE1IDcuMTkxMTlaIiBmaWxsPSIjMTYxODIzIiBmaWxsLW9wYWNpdHk9IjAuNiIvPgo8cGF0aCBkPSJNMTYuNzE3MiAxNi43MTgzQzE2LjUyMTkgMTYuNTIzMSAxNi41MjMxIDE2LjIwNzQgMTYuNzA3MiAxNi4wMDE3QzE5LjcyNTcgMTIuNjMgMTkuNzI1NyA3LjM3MTY4IDE2LjcwNzIgNC4wMDAwMUMxNi41MjMxIDMuNzk0MjcgMTYuNTIxOSAzLjQ3ODU4IDE2LjcxNzIgMy4yODMzMkwxNy40MjQzIDIuNTc2MjFDMTcuNjE5NSAyLjM4MDk1IDE3LjkzNyAyLjM4MDIgMTguMTIzMyAyLjU4NDA4QzIxLjkwOTkgNi43MjkyNiAyMS45MDk5IDEzLjI3MjQgMTguMTIzMyAxNy40MTc2QzE3LjkzNyAxNy42MjE1IDE3LjYxOTUgMTcuNjIwNyAxNy40MjQzIDE3LjQyNTVMMTYuNzE3MiAxNi43MTgzWiIgZmlsbD0iIzE2MTgyMyIgZmlsbC1vcGFjaXR5PSIwLjYiLz4KPC9zdmc+Cg=="]';

const SOUND_VOLUME_ICON_CLICK_UPLOAD_SELECTOR =
  'img[src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjEiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMSAyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTAgNy41MDE2QzAgNi42NzMxNyAwLjY3MTU3MyA2LjAwMTYgMS41IDYuMDAxNkgzLjU3NzA5QzMuODY4MDUgNi4wMDE2IDQuMTQ0NTggNS44NzQ4OCA0LjMzNDU1IDUuNjU0NDlMOC43NDI1NSAwLjU0MDUyQzkuMzQ3OCAtMC4xNjE2NjggMTAuNSAwLjI2NjM3NCAxMC41IDEuMTkzNDFWMTguOTY3MkMxMC41IDE5Ljg3NDUgOS4zODg5NCAyMC4zMTI5IDguNzY5NDIgMTkuNjVMNC4zMzE3OSAxNC45MDIxQzQuMTQyNjkgMTQuNjk5OCAzLjg3ODE2IDE0LjU4NDkgMy42MDEyMiAxNC41ODQ5SDEuNUMwLjY3MTU3MyAxNC41ODQ5IDAgMTMuOTEzNCAwIDEzLjA4NDlWNy41MDE2Wk01Ljg0OTQ1IDYuOTYwMjdDNS4yNzk1NiA3LjYyMTQzIDQuNDQ5OTcgOC4wMDE2IDMuNTc3MDkgOC4wMDE2SDJWMTIuNTg0OUgzLjYwMTIyQzQuNDMyMDMgMTIuNTg0OSA1LjIyNTY0IDEyLjkyOTUgNS43OTI5NSAxMy41MzY0TDguNSAxNi4wMDAxIDEzLjI3MjQgMTguMTIzMyAxNy40MTc2QzE3LjkzNyAxNy42MjE1IDE3LjYxOTUgMTcuNjIwNyAxNy40MjQzIDE3LjQyNTVMMTYuNzE3MiAxNi43MTgzWiIgZmlsbD0iIzE2MTgyMyIgZmlsbC1vcGFjaXR5PSIwLjYiLz4KPC9zdmc+Cg=="]';

const SOUND_VOLUME_ICON_CLICK_DRAFT_SELECTOR =
  'img[src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjEiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMSAyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTAgNy41MDE2QzAgNi42NzMxNyAwLjY3MTU3MyA2LjAwMTYgMS41IDYuMDAxNkgzLjU3NzA5QzMuODY4MDUgNi4wMDE2IDQuMTQ0NTggNS44NzQ4OCA0LjMzNDU1IDUuNjU0NDlMOC43NDI1NSAwLjU0MDUyQzkuMzQ3OCAtMC4xNjE2NjggMTAuNSAwLjI2NjM3NCAxMC41IDEuMTkzNDFWMTguOTY3MkMxMC41IDE5Ljg3NDUgOS4zODg5NCAyMC4zMTI5IDguNzY5NDIgMTkuNjVMNC4zMzE3OSAxNC45MDIxQzQuMTQyNjkgMTQuNjk5OCAzLjg3ODE2IDE0LjU4NDkgMy42MDEyMiAxNC41ODQ5SDEuNUMwLjY3MTU3MyAxNC41ODQ5IDAgMTMuOTEzNCAwIDEzLjA4NDlWNy41MDE2Wk01Ljk0OTQ1IDYuOTYwMjdDNS4yNzk1NiA3LjYyMTQzIDQuNDQ5OTcgOC4wMDE2IDMuNTc3MDkgOC4wMDE2SDJWMTIuNTg0OUgzLjYwMTIyQzQuNDMyMDMgMTIuNTg0OSA1LjIyNTY0IDEyLjkyOTUgNS43OTI5NSAxMy41MzY0TDguNSAxNi40MzI4VjMuODg1MjJMNS44NDk0NSA2Ljk2MDI3WiIgZmlsbD0iIzE2MTgyMyIgZmlsbC1vcGFjaXR5PSIwLjYiLz4KPC9zdmc+Cg=="]';

const DRAFT_EDIT_ICON_SELECTOR =
  "path[d='M37.37 4.85a4.01 4.01 0 0 0-.99-.79 3 3 0 0 0-2.72 0c-.45.23-.81.6-1 .79a9 9 0 0 1-.04.05l-19.3 19.3c-1.64 1.63-2.53 2.52-3.35 3.47a36 36 0 0 0-4.32 6.16c-.6 1.1-1.14 2.24-2.11 4.33l-.3.6c-.4.75-.84 1.61-.8 2.43a2.5 2.5 0 0 0 2.37 2.36c.82.05 1.68-.4 2.44-.79l.59-.3c2.09-.97 3.23-1.5 4.33-2.11a36 36 0 0 0 6.16-4.32c.95-.82 1.84-1.71 3.47-3.34l19.3-19.3.05-.06a3 3 0 0 0 .78-3.71c-.22-.45-.6-.81-.78-1l-.02-.02-.03-.03-3.67-3.67a8.7 8.7 0 0 1-.06-.05ZM16.2 26.97 35.02 8.15l2.83 2.83L19.03 29.8c-1.7 1.7-2.5 2.5-3.33 3.21a32 32 0 0 1-7.65 4.93 32 32 0 0 1 4.93-7.65c.73-.82 1.51-1.61 3.22-3.32Z']";

// Roboflow detection models used for captcha solving.
const ROBOLOFLOW_API_KEY = 'kyHFbAWkOWfGz8fSEw8O';

function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

function checkForUpdates() {
  const currentVersion = require('../package.json').version;

  return fetch('https://registry.npmjs.org/tiktokautouploader/latest')
    .then((response) => {
      if (response.status === 200) {
        return response.json().then((data) => {
          const latestVersion = data.version;
          if (currentVersion !== latestVersion) {
            console.log(
              `WARNING: You are using version ${currentVersion} of tiktokautouploader, ` +
                `PLEASE UPDATE TO LATEST VERSION ${latestVersion} FOR BEST EXPERIENCE.`
            );
          }
        });
      }
      return undefined;
    })
    .catch(() => undefined);
}

function loginWarning(accountname) {
  console.log(
    `NO COOKIES FILE FOUND FOR ACCOUNT ${accountname}, PLEASE LOG-IN TO ${accountname} WHEN PROMPTED`
  );
}

function saveCookies(cookies) {
  fs.writeFileSync('TK_cookies.json', JSON.stringify(cookies, null, 4));
}

function checkExpiry(accountname) {
  const cookies = JSON.parse(fs.readFileSync(`TK_cookies_${accountname}.json`, 'utf8'));

  const currentTime = Math.floor(Date.now() / 1000);
  const cookiesExpire = [];

  for (const cookie of cookies) {
    if (['sessionid', 'sid_tt', 'sessionid_ss', 'passport_auth_status'].includes(cookie.name)) {
      let expiry = cookie.expires;
      if (!expiry) {
        expiry = cookie.expirationDate;
      }
      cookiesExpire.push(expiry < currentTime);
    }
  }

  return cookiesExpire.length > 0 && cookiesExpire.every(Boolean);
}

async function runJavaScript(proxyData = null) {
  try {
    await login(proxyData);
  } catch (e) {
    throw new TikTokUploadError(
      `Error while running the JavaScript file, when trying to parse cookies: ${e.message}`
    );
  }
}

function readCookies(cookiesPath) {
  let cookies = [];

  try {
    cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));

    for (const cookie of cookies) {
      if (!['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
        cookie.sameSite = 'Lax';
      }
    }
  } catch (e) {
    throw new TikTokUploadError('ERROR: CANT READ COOKIES FILE');
  }

  return { cookies, cookieRead: true };
}

function detectRedirect(page) {
  let redirectDetected = false;

  page.on('response', (response) => {
    if (response.request().redirectedFrom()) {
      redirectDetected = true;
    }
  });

  // Kept identical to the Python helper: the listener is registered but the
  // value returned at call time is always false.
  return redirectDetected;
}

function understoodQs(question) {
  const understoodTerms = {
    touchdowns: 'football',
    'orange and round': 'basketball',
    'used in hoops': 'basketball',
    'has strings': 'guitar',
    'oval and inflatable': 'football',
    strumming: 'guitar',
    bounces: 'basketball',
    'musical instrument': 'guitar',
    laces: 'football',
    bands: 'guitar',
    leather: 'football',
    leaves: 'tree',
    pages: 'book',
    throwing: 'football',
    'tossed in a spiral': 'football',
    'spiky crown': 'pineapple',
    pigskin: 'football',
    photography: 'camera',
    lens: 'camera',
    grow: 'tree',
    'captures images': 'camera',
    'keeps doctors': 'apple',
    crown: 'pineapple',
    driven: 'car',
  };

  for (const key of Object.keys(understoodTerms)) {
    if (question.includes(key)) {
      return understoodTerms[key];
    }
  }

  return 'N.A';
}

function getImageSrc(page) {
  return page.getAttribute(CAPTCHA_IMAGE_SELECTOR, 'src');
}

async function downloadImage(imageUrl) {
  const response = await fetch(imageUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  const imagePath = 'captcha_image.jpg';
  fs.writeFileSync(imagePath, buffer);
  return imagePath;
}

/**
 * Reads pixel dimensions from a PNG or JPEG buffer (Pillow's Image.size).
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}}
 */
function getImageSize(buffer) {
  // PNG: IHDR width/height at bytes 16..24
  if (
    buffer.length > 24 &&
    buffer[0] === 0x89 &&
    buffer.toString('ascii', 1, 4) === 'PNG'
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk the marker segments until a start-of-frame marker
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;

    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];

      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }

      if (offset + 4 > buffer.length) {
        break;
      }

      const length = buffer.readUInt16BE(offset + 2);

      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }

      offset += 2 + length;
    }
  }

  throw new TikTokUploadError('ERROR: CANT READ CAPTCHA IMAGE SIZE');
}

async function roboflowInfer(imagePath, modelId) {
  const image = fs.readFileSync(imagePath).toString('base64');

  const response = await fetch(
    `https://detect.roboflow.com/${modelId}?api_key=${ROBOLOFLOW_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: image,
    }
  );

  if (!response.ok) {
    throw new Error(`Roboflow inference failed with status code: ${response.status}`);
  }

  return response.json();
}

async function runInferenceOnImageTougher(imagePath, object) {
  const results = await roboflowInfer(imagePath, 'captcha-2-6ehbe/2');

  const classNames = [];
  const boundingBoxes = [];

  for (const obj of results.predictions || []) {
    classNames.push(obj.class);
    boundingBoxes.push({
      x: obj.x,
      y: obj.y,
      width: obj.width,
      height: obj.height,
    });
  }

  const boundingBox = [];
  const classToClick = object;

  for (let i = 0; i < classNames.length; i++) {
    if (classNames[i] === classToClick) {
      boundingBox.push(boundingBoxes[i]);
    }
  }

  return boundingBox;
}

async function runInferenceOnImage(imagePath) {
  const results = await roboflowInfer(imagePath, 'tk-3nwi9/2');

  const classNames = [];
  const boundingBoxes = [];

  for (const obj of results.predictions || []) {
    classNames.push(obj.class);
    boundingBoxes.push({
      x: obj.x,
      y: obj.y,
      width: obj.width,
      height: obj.height,
    });
  }

  const alreadyWritten = [];
  const boundingBox = [];
  const classToClick = [];

  for (let i = 0; i < classNames.length; i++) {
    const detectedClass = classNames[i];

    if (alreadyWritten.includes(detectedClass)) {
      classToClick.push(detectedClass);
      boundingBox.push(boundingBoxes[i]);
      const index = alreadyWritten.indexOf(detectedClass);
      boundingBox.push(boundingBoxes[index]);
    }

    alreadyWritten.push(detectedClass);
  }

  const found = classToClick.length === 1;

  return [boundingBox, found];
}

function convertToWebpageCoordinates(
  boundingBoxes,
  imageX,
  imageY,
  imageHeightWeb,
  imageWidthWeb,
  imageHeightReal,
  imageWidthReal
) {
  const webpageCoordinates = [];

  for (const box of boundingBoxes) {
    const xBox = box.x;
    const yBox = box.y;
    const relX = (xBox * imageWidthWeb) / imageWidthReal;
    const relY = (yBox * imageHeightWeb) / imageHeightReal;
    const xCord = imageX + relX;
    const yCord = imageY + relY;
    webpageCoordinates.push([xCord, yCord]);
  }

  return webpageCoordinates;
}

async function clickOnObjects(page, objectCoords) {
  for (const [x, y] of objectCoords) {
    await page.mouse.click(x, y);
    await sleep(500);
  }
}

async function validateProxy(proxy) {
  if (!proxy) {
    return;
  }

  if (typeof proxy !== 'object' || proxy === null || Array.isArray(proxy)) {
    throw new Error('Proxy must be a dictionary.');
  }

  if (!('server' in proxy) || typeof proxy.server !== 'string') {
    throw new Error("Proxy must contain a 'server' key with a string value.");
  }

  try {
    let proxyUrl = `http://${proxy.server}`;
    if (proxy.username) {
      proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.server}`;
    }

    const agent = new HttpsProxyAgent(proxyUrl);

    const statusCode = await new Promise((resolve, reject) => {
      const request = https.get('https://www.google.com', { agent }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });

      request.on('error', reject);
      request.setTimeout(30000, () => {
        request.destroy(new Error('Proxy test request timed out'));
      });
    });

    if (statusCode === 200) {
      console.log('Proxy is valid!');
    } else {
      throw new Error(`Proxy test failed with status code: ${statusCode}`);
    }
  } catch (e) {
    throw new Error(`Invalid proxy configuration when trying to simple request: ${e.message}`);
  }
}

async function makeStealthContext(headless, proxy) {
  const browser = await chromium.launch({
    headless,
    proxy: proxy || undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--lang=en-US',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // The stealth evasions are applied globally by ./browser. Language headers
  // are pinned here, matching Phantomwright's navigator_languages_override.
  try {
    await context.addInitScript(
      'navigator.languages = Object.freeze(["en-US", "en"]);'
    );
  } catch (e) {
    /* init script is best-effort */
  }

  return { browser, context };
}

async function selectSoundFromFavorites(page, soundName, sim = null, stealth = false, suppressprint = false) {
  /**
   * Selects a sound from the favorites tab by searching through the list.
   * Returns true if the sound was found and selected, false otherwise.
   */
  try {
    if (stealth) {
      await sleep(1000);
    }

    try {
      await page.click('button:has-text("Favorites")');
    } catch (e) {
      try {
        await page.click('button#favourite');
      } catch (e2) {
        await page.click('div.TUXTabBar-item#favourite button');
      }
    }

    await sleep(1000);
    if (stealth) {
      await sleep(1000);
    }

    await page.waitForSelector('div[class*="MusicPanelMusicItem__content"]', { timeout: 50000 });
    await sleep(2500);

    const musicCards = page.locator('div[class*="MusicPanelMusicItem__content"]');
    const cardCount = await musicCards.count();

    if (!suppressprint) {
      console.log(`Found ${cardCount} favorite sounds, searching for '${soundName}'...`);
    }

    const keywords = soundName.split(' ');
    const keywordsLower = keywords.filter((kw) => kw.trim()).map((kw) => kw.toLowerCase());

    if (!suppressprint && keywordsLower.length > 1) {
      console.log(`Searching for sounds containing all keywords: ${keywordsLower}`);
    }

    let found = false;

    for (let i = 0; i < cardCount; i++) {
      try {
        const card = musicCards.nth(i);

        const titleElement = card.locator('div[class*="MusicPanelMusicItem__infoBasicTitle"]');
        const titleText = (await titleElement.count()) > 0 ? await titleElement.innerText() : '';

        const otherElement = card.locator('div[class*="MusicPanelMusicItem__infoBasicDesc"]');
        const otherText = (await otherElement.count()) > 0 ? await otherElement.innerText() : '';

        const combinedText = `${titleText} ${otherText}`.trim().toLowerCase();
        const allKeywordsMatch = keywordsLower.every((kw) => combinedText.includes(kw));

        if (allKeywordsMatch && combinedText) {
          const displayTitle = titleText || 'Unknown';
          if (!suppressprint) {
            console.log(`Found matching sound: '${displayTitle} ${otherText}'`);
          }

          if (stealth) {
            await sleep(500);
          }

          if (sim) {
            await sim.prepareForInteraction(card);
            await sleep(300);
            await sim.click(card);
          } else {
            await card.hover();
            await sleep(300);
            await card.click();
          }

          await card.locator('button').last().click();
          if (stealth) {
            await sleep(1000);
          }

          found = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    return found;
  } catch (e) {
    if (!suppressprint) {
      console.log(`Error in favorites search: ${e.message}`);
    }
    return false;
  }
}

async function selectSoundFromSearch(page, soundName, sim = null, stealth = false) {
  /**
   * Selects a sound using the search functionality (original behavior).
   * Uses the UserSimulator for human-like typing when available.
   */
  const searchBox = page.getByPlaceholder('Search sounds');

  if (sim) {
    await sim.click(searchBox);
    await sim.type(searchBox, soundName);
  } else {
    await searchBox.click();
    await page.keyboard.type(soundName);
  }

  await sleep(200);
  if (stealth) {
    await sleep(2000);
  }
  await page.keyboard.press('Enter');

  try {
    await page.waitForSelector("div[class*='MusicPanelMusicItem__operation']");
    if (stealth) {
      await sleep(500);
    }
    await page.locator("div[class*='MusicPanelMusicItem__operation']").first().click();
    if (stealth) {
      await sleep(1000);
    }
    return true;
  } catch (e) {
    return false;
  }
}

function cookieFile(accountname) {
  return `TK_cookies_${accountname}.json`;
}

async function loadOrCreateCookies(accountname, proxy) {
  let cookieRead = false;
  let cookies = [];
  const cookiesPath = cookieFile(accountname);

  if (fs.existsSync(cookiesPath)) {
    ({ cookies, cookieRead } = readCookies(cookiesPath));
    const expired = checkExpiry(accountname);
    if (expired) {
      fs.rmSync(cookiesPath);
      console.log(`COOKIES EXPIRED FOR ACCOUNT ${accountname}, PLEASE LOG-IN AGAIN`);
      cookieRead = false;
    }
  }

  if (!cookieRead) {
    loginWarning(accountname);
    await runJavaScript(proxy);
    fs.renameSync('TK_cookies.json', cookiesPath);
    ({ cookies, cookieRead } = readCookies(cookiesPath));
    if (!cookieRead) {
      throw new TikTokUploadError('ERROR READING COOKIES');
    }
  }

  return cookies;
}

async function gotoWithRetry(page, url) {
  let retries = 0;

  while (retries < 2) {
    try {
      await page.goto(url, { timeout: 30000 });
      break;
    } catch (e) {
      retries += 1;
      await sleep(5000);
      if (retries === 2) {
        throw new TikTokUploadError('ERROR: TIK TOK PAGE FAILED TO LOAD, try again.');
      }
    }
  }
}

async function waitForUploadOrCaptcha(page) {
  let detected = false;
  let captcha = false;

  while (!detected) {
    if (await page.locator('.upload-text-container').isVisible()) {
      detected = true;
    } else if (await page.locator(CAPTCHA_QUESTION_SELECTOR).isVisible()) {
      detected = true;
      captcha = true;
    } else {
      await sleep(100);
    }
  }

  return captcha;
}

async function solveCaptchaIfNeeded(page, suppressprint) {
  let image = await getImageSrc(page);
  if (!image) {
    return;
  }

  if (!suppressprint) {
    console.log('CAPTCHA DETECTED, Attempting to solve');
  }

  let solved = false;
  let attempts = 0;
  let oldQuestion = 'N.A';
  let question = await page.locator(CAPTCHA_QUESTION_SELECTOR).textContent();

  while (!solved) {
    attempts += 1;
    let startTime = Date.now();

    while (question === oldQuestion) {
      question = await page.locator(CAPTCHA_QUESTION_SELECTOR).textContent();
      if (Date.now() - startTime > 2000) {
        break;
      }
    }

    if (
      question.includes('Select 2 objects that are the same') ||
      question.includes('Select two objects that are the same')
    ) {
      let found = false;
      let imgPath = null;
      let bBox = [];

      while (!found) {
        await page.click(CAPTCHA_REFRESH_SELECTOR);
        image = await getImageSrc(page);
        imgPath = await downloadImage(image);
        const [bBoxResult, foundResult] = await runInferenceOnImage(imgPath);
        bBox = bBoxResult;
        found = foundResult;
      }

      const imageSize = getImageSize(fs.readFileSync(imgPath));

      const imageweb = page.locator('#captcha-verify-image');
      await imageweb.waitFor();
      const box = await imageweb.boundingBox();
      const imageX = box.x;
      const imageY = box.y;
      const imageHeightWeb = box.height;
      const imageWidthWeb = box.width;
      const imageWidthReal = imageSize.width;
      const imageHeightReal = imageSize.height;

      const webpageCoords = convertToWebpageCoordinates(
        bBox,
        imageX,
        imageY,
        imageHeightWeb,
        imageWidthWeb,
        imageHeightReal,
        imageWidthReal
      );

      if (webpageCoords.length === 0) {
        webpageCoords.push([imageX + 50, imageY + 50]);
      }

      await clickOnObjects(page, webpageCoords);
      await page.click(CAPTCHA_SUBMIT_SELECTOR);
      await sleep(500);

      if (attempts > 5) {
        throw new TikTokUploadError('FAILED TO SOLVE CAPTCHA');
      }

      let showedup = false;
      while (!showedup) {
        if (await page.locator(CAPTCHA_SUCCESS_SELECTOR).isVisible()) {
          solved = true;
          showedup = true;
          fs.rmSync('captcha_image.jpg', { force: true });
        }
        if (await page.locator(CAPTCHA_FAIL_SELECTOR).isVisible()) {
          showedup = true;
          oldQuestion = question;
          await page.click(CAPTCHA_REFRESH_SELECTOR);
        }
      }
    } else {
      let objectclick = understoodQs(question);

      while (objectclick === 'N.A') {
        oldQuestion = question;
        await page.click(CAPTCHA_REFRESH_SELECTOR);
        startTime = Date.now();
        let runs = 0;

        while (question === oldQuestion) {
          runs += 1;
          question = await page.locator(CAPTCHA_QUESTION_SELECTOR).textContent();
          if (runs > 1) {
            await sleep(1000);
          }
          if (Date.now() - startTime > 2000) {
            break;
          }
        }

        objectclick = understoodQs(question);
      }

      image = await getImageSrc(page);
      const imgPath = await downloadImage(image);
      const bBox = await runInferenceOnImageTougher(imgPath, objectclick);

      const imageSize = getImageSize(fs.readFileSync(imgPath));

      const imageweb = page.locator('#captcha-verify-image');
      await imageweb.waitFor();
      const box = await imageweb.boundingBox();
      const imageX = box.x;
      const imageY = box.y;
      const imageHeightWeb = box.height;
      const imageWidthWeb = box.width;
      const imageWidthReal = imageSize.width;
      const imageHeightReal = imageSize.height;

      const webpageCoords = convertToWebpageCoordinates(
        bBox,
        imageX,
        imageY,
        imageHeightWeb,
        imageWidthWeb,
        imageHeightReal,
        imageWidthReal
      );

      if (webpageCoords.length === 0) {
        webpageCoords.push([imageX + 50, imageY + 50]);
      }

      await clickOnObjects(page, webpageCoords);
      await page.click(CAPTCHA_SUBMIT_SELECTOR);
      await sleep(1000);

      if (attempts > 20) {
        throw new TikTokUploadError('FAILED TO SOLVE CAPTCHA');
      }

      let showedup = false;
      while (!showedup) {
        if (await page.locator(CAPTCHA_SUCCESS_SELECTOR).isVisible()) {
          solved = true;
          showedup = true;
          fs.rmSync('captcha_image.jpg', { force: true });
          if (!suppressprint) {
            console.log('CAPTCHA SOLVED');
          }
        }
        if (await page.locator(CAPTCHA_FAIL_SELECTOR).isVisible()) {
          showedup = true;
          oldQuestion = question;
          await page.click(CAPTCHA_REFRESH_SELECTOR);
        }
      }
    }
  }
}

async function setVideoInput(page, video) {
  try {
    await page.setInputFiles('input[type="file"][accept="video/*"]', `${video}`);
  } catch (e) {
    throw new TikTokUploadError(
      'ERROR: FAILED TO INPUT FILE. Possible Issues: Wifi too slow, file directory wrong, or check documentation to see if captcha is solvable'
    );
  }
}

async function addDescriptionAndHashtags(
  page,
  sim,
  video,
  description,
  hashtags,
  stealth,
  suppressprint
) {
  await page.waitForSelector('div[data-contents="true"]');

  await sleep(500);
  if (await page.locator("button:has-text('Cancel')").isVisible()) {
    console.log('Tutorial pop-up detected, dismissing...');
    await page.click("button:has-text('Cancel')");
  }
  if (await page.locator("button:has-text('Got it')").isVisible()) {
    await page.click("button:has-text('Got it')");
  }

  const descBox = page.locator('div[data-contents="true"]');
  await sim.click(descBox);

  if (!suppressprint) {
    console.log(
      'Entered File, waiting for tiktok to load onto their server, this may take a couple of minutes, depending on your video length'
    );
  }

  await sleep(500);
  if (description === null || description === undefined) {
    throw new TikTokUploadError('ERROR: PLEASE INCLUDE A DESCRIPTION');
  }

  for (let i = 0; i < `${video}`.length + 2; i++) {
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
  }

  await sleep(500);
  await sim.type(descBox, description);

  if (hashtags !== null && hashtags !== undefined) {
    if (!Array.isArray(hashtags)) {
      throw new TikTokUploadError('ERROR: PLEASE PROVIDE HASHTAGS AS AN ARRAY');
    }

    for (let hashtag of hashtags) {
      if (hashtag[0] !== '#') {
        hashtag = `#${hashtag}`;
      }

      await page.keyboard.type(hashtag);
      await sleep(500);

      try {
        if (stealth) {
          await sleep(2000);
        }
        await page.click(`span.hash-tag-topic:has-text("${hashtag}")`, { timeout: 1000 });
      } catch (e) {
        try {
          await page.click('span.hash-tag-topic', { timeout: 1000 });
        } catch (e2) {
          await page.keyboard.press('Backspace');
          try {
            await page.click('span.hash-tag-topic', { timeout: 1000 });
          } catch (e3) {
            if (!suppressprint) {
              console.log(`Tik tok hashtag not working for ${hashtag}, moving onto next`);
            }
            await page.keyboard.type(`${hashtag[hashtag.length - 1]} `);
          }
        }
      }
    }
  }

  if (!suppressprint) {
    console.log('Description and Hashtags added');
  }
}

async function waitForUploadReady(page) {
  const contentCheckBtn = page.locator(
    "div.common-modal-footer > button[data-type='neutral']",
    { hasText: 'Cancel' }
  );

  if (await contentCheckBtn.isVisible()) {
    await contentCheckBtn.click();
  }

  try {
    await page.waitForSelector('button:has-text("Post")[aria-disabled="false"]', {
      timeout: 12000000,
    });
  } catch (e) {
    throw new TikTokUploadError(
      'ERROR: TIK TOK TOOK TOO LONG TO UPLOAD YOUR FILE (>20min). Try again, if issue persists then try a lower file size or different wifi connection'
    );
  }
}

function validateScheduleRequest(schedule, day) {
  if ((schedule === null || schedule === undefined) && (day !== null && day !== undefined)) {
    throw new TikTokUploadError(
      "ERROR: CANT SCHEDULE FOR ANOTHER DAY USING 'day' WITHOUT ALSO INCLUDING TIME OF UPLOAD WITH 'schedule'; PLEASE ALSO INCLUDE TIME WITH 'schedule' PARAMETER"
    );
  }
}

function normalizeScheduleAndDay(schedule, day) {
  // Backward-compatible normalization for callers that pass the day number via
  // `schedule` and the time string via `day` (e.g. schedule=25, day="12:05").
  if (Number.isInteger(schedule) && typeof day === 'string' && day.includes(':')) {
    return [day, String(schedule)];
  }
  return [schedule, day];
}

async function applySchedule(page, schedule, day, stealth, suppressprint) {
  if (schedule === null || schedule === undefined) {
    return;
  }

  let hour;
  let minute;

  try {
    hour = schedule.slice(0, 2);
    minute = schedule.slice(3);

    if (parseInt(minute, 10) % 5 !== 0) {
      throw new TikTokUploadError(
        'MINUTE FORMAT ERROR: PLEASE MAKE SURE MINUTE YOU SCHEDULE AT IS A MULTIPLE OF 5 UNTIL 60 (i.e: 40), VIDEO SAVED AS DRAFT'
      );
    }
  } catch (e) {
    throw new TikTokUploadError(
      "SCHEDULE TIME ERROR: PLEASE MAKE SURE YOUR SCHEDULE TIME IS A STRING THAT FOLLOWS THE 24H FORMAT 'HH:MM', VIDEO SAVED AS DRAFT"
    );
  }

  await page.locator('label:has-text("Schedule")').click();
  if (stealth) {
    await sleep(2000);
  }

  let visible = false;
  while (!visible) {
    if (await page.locator('button:has-text("Allow")').nth(0).isVisible()) {
      if (stealth) {
        await sleep(1000);
      }
      await page.locator('button:has-text("Allow")').nth(0).click();
      visible = true;
      await sleep(100);
    } else if (await page.locator('div.TUXTextInputCore-trailingIconWrapper').nth(1).isVisible()) {
      visible = true;
      await sleep(100);
    }
  }

  if (day !== null && day !== undefined) {
    if (stealth) {
      await sleep(1000);
    }
    await page.locator(SCHEDULE_DAY_ICON_SELECTOR).click();
    await sleep(200);

    try {
      if (stealth) {
        await sleep(1000);
      }
      await page.locator(`span.day.valid:text-is("${day}")`).click();
    } catch (e) {
      throw new TikTokUploadError(
        'SCHEDULE DAY ERROR: ERROR WITH SCHEDULED DAY, read documentation for more information on format of day'
      );
    }
  }

  try {
    await sleep(200);
    await page.locator(SCHEDULE_TIME_ICON_SELECTOR).click();
    await sleep(200);

    await page
      .locator(`.tiktok-timepicker-option-text.tiktok-timepicker-right:text-is("${minute}")`)
      .scrollIntoViewIfNeeded();
    await sleep(200);
    if (stealth) {
      await sleep(2000);
    }
    await page
      .locator(`.tiktok-timepicker-option-text.tiktok-timepicker-right:text-is("${minute}")`)
      .click();
    await sleep(200);

    if (await page.locator('div.tiktok-timepicker-time-picker-container').isVisible()) {
      await sleep(100);
    } else {
      await page.locator(SCHEDULE_TIME_ICON_SELECTOR).click();
    }

    await page
      .locator(`.tiktok-timepicker-option-text.tiktok-timepicker-left:text-is("${hour}")`)
      .scrollIntoViewIfNeeded();
    if (stealth) {
      await sleep(2000);
    }
    await page
      .locator(`.tiktok-timepicker-option-text.tiktok-timepicker-left:text-is("${hour}")`)
      .click();
    await sleep(1000);

    if (!suppressprint) {
      console.log('Done scheduling video');
    }
  } catch (e) {
    throw new TikTokUploadError('SCHEDULING ERROR: VIDEO SAVED AS DRAFT');
  }
}

async function adjustSoundVolumeUpload(page, soundAudVol, stealth) {
  await page.waitForSelector(SOUND_VOLUME_ICON_WAIT_SELECTOR);
  if (stealth) {
    await sleep(1000);
  }

  await page.click(SOUND_VOLUME_ICON_CLICK_UPLOAD_SELECTOR);
  await sleep(500);

  const sliders = page.locator('input.scaleInput');

  if (soundAudVol === 'background') {
    const slider2 = sliders.nth(1);
    const boundingBox2 = await slider2.boundingBox();
    if (boundingBox2) {
      const x2 = boundingBox2.x + boundingBox2.width * 0.07;
      const y2 = boundingBox2.y + boundingBox2.height / 2;
      if (stealth) {
        await sleep(1000);
      }
      await page.mouse.click(x2, y2);
    }
  }

  if (soundAudVol === 'main') {
    const slider1 = sliders.nth(0);
    const boundingBox1 = await slider1.boundingBox();
    if (boundingBox1) {
      const x1 = boundingBox1.x + boundingBox1.width * 0.07;
      const y1 = boundingBox1.y + boundingBox1.height / 2;
      if (stealth) {
        await sleep(1000);
      }
      await page.mouse.click(x1, y1);
    }
  }

  await sleep(1000);
}

async function pickSound(page, soundName, sim, stealth, suppressprint, searchMode) {
  let soundFound = false;

  if (searchMode === 'favorites') {
    soundFound = await selectSoundFromFavorites(
      page,
      soundName,
      sim,
      stealth,
      suppressprint
    );
  } else {
    soundFound = await selectSoundFromSearch(page, soundName, sim, stealth);
  }

  if (!soundFound) {
    throw new TikTokUploadError(`ERROR: SOUND '${soundName}' NOT FOUND`);
  }
}

async function addSoundFromUploadPage(
  page,
  soundName,
  soundAudVol,
  sim,
  stealth,
  suppressprint,
  searchMode
) {
  let soundFail = false;

  if (soundName === null || soundName === undefined) {
    return soundFail;
  }

  try {
    if (stealth) {
      await sleep(2000);
    }
    const soundsBtn = page.locator("button:has-text('Sounds')").last();
    await sim.click(soundsBtn);
  } catch (e) {
    soundFail = true;
  }

  if (soundFail) {
    return soundFail;
  }

  await sleep(1500);
  await pickSound(page, soundName, sim, stealth, suppressprint, searchMode);

  if (soundAudVol !== 'mix') {
    try {
      await adjustSoundVolumeUpload(page, soundAudVol, stealth);
    } catch (e) {
      throw new TikTokUploadError(
        "ERROR ADJUSTING SOUND VOLUME: please try again or use the default 'mix'."
      );
    }
  }

  await page.waitForSelector("button:has-text('Save')");
  if (stealth) {
    await sleep(1000);
  }
  await page.locator("button:has-text('Save')").first().click();

  if (!suppressprint) {
    console.log('Added sound');
  }

  return soundFail;
}

async function runUploadCopyrightCheck(page, stealth, suppressprint) {
  let copyCheckCounter = 0;
  if (stealth) {
    await sleep(1000);
  }

  await page.locator('div[data-e2e="copyright_container"] span[data-part="thumb"]').click();

  while (true) {
    await sleep(2000);

    if (await page.getByText('No issues found.', { exact: true }).isVisible()) {
      if (!suppressprint) {
        console.log('Copyright check complete');
      }
      break;
    }

    if (await page.locator("span:has-text('Copyright issues detected')").isVisible()) {
      throw new TikTokUploadError(
        'COPYRIGHT CHECK FAILED: VIDEO SAVED AS DRAFT, COPYRIGHT AUDIO DETECTED FROM TIKTOK'
      );
    }

    copyCheckCounter += 1;
    if (copyCheckCounter > 10) {
      console.log(
        'COPYRIGHT CHECK TIMEOUT: UNABLE TO CONFIRM IF VIDEO PASSED COPYRIGHT CHECK, CONTINUING TO UPLOAD IN 5 SECONDS.'
      );
      break;
    }
  }
}

async function submitUpload(
  page,
  schedule,
  stealth,
  suppressprint,
  postSuccessWait,
  scheduleSuccessWait
) {
  try {
    if (schedule === null || schedule === undefined) {
      if (stealth) {
        await sleep(1000);
      }

      try {
        // 1. Click the regular "Post" button
        await page.click('button:has-text("Post")[data-e2e="post_video_button"]', {
          timeout: 2000,
        });

        // --- FIX: confirm the "Continue to post?" pop-up if it appears ---
        try {
          await page.locator('button:has-text("Post now")').click({ timeout: 3000 });
        } catch (e) {
          /* no pop-up */
        }
        // -----------------------------------------------------------------

        await page.waitForURL(CONTENT_URL, { timeout: 2000 });
      } catch (e) {
        // Fallback for the second click
        try {
          await page.click('button:has-text("Post")[aria-disabled="false"]', { timeout: 2000 });
        } catch (e2) {
          /* ignore */
        }

        // --- FIX (second check just in case) ---
        try {
          await page.locator('button:has-text("Post now")').click({ timeout: 3000 });
        } catch (e2) {
          /* ignore */
        }
        // --------------------------------------

        try {
          await page.waitForURL(CONTENT_URL, { timeout: 2000 });
        } catch (e2) {
          console.log(
            'POSSIBLE ERROR: Cannot confirm if uploaded successfully, Please check account in a minute or two to confirm'
          );
          return 'Error';
        }
      }

      let uploaded = false;
      let checks = 0;

      while (!uploaded) {
        if (
          await page
            .locator(':has-text("Leaving the page does not interrupt")')
            .nth(0)
            .isVisible()
        ) {
          await sleep(postSuccessWait * 1000);
          break;
        }
        await sleep(200);
        checks += 1;
        if (checks === 25) {
          break;
        }
      }
    } else {
      if (stealth) {
        await sleep(1000);
      }

      // Click to confirm the schedule
      await page.click('button:has-text("Schedule")', { timeout: 10000 });

      // --- FIX for scheduling ---
      try {
        await page.locator('button:has-text("Post now")').click({ timeout: 3000 });
      } catch (e) {
        /* ignore */
      }
      // ---------------------------

      let uploaded = false;
      let checks = 0;

      while (!uploaded) {
        if (
          await page
            .locator(':has-text("Leaving the page does not interrupt")')
            .nth(0)
            .isVisible()
        ) {
          await sleep(scheduleSuccessWait * 1000);
          break;
        }
        await sleep(200);
        checks += 1;
        if (checks === 25) {
          break;
        }
      }
    }

    if (!suppressprint) {
      console.log(
        'Done uploading video, NOTE: it may take a minute or two to show on TikTok'
      );
    }
  } catch (e) {
    await sleep(2000);
    throw new TikTokUploadError(
      'POSSIBLE ERROR UPLOADING: Cannot confirm if uploaded successfully, Please check account in a minute or two to confirm.'
    );
  }

  await sleep(1000);
  await page.close();
  return null;
}

async function selectCoverLastFrame(page) {
  /**
   * Opens TikTok Studio's cover editor and drags the frame slider to the last frame.
   *
   * The caller must ensure the desired cover image is already the last frame
   * of the MP4 (baked in at encode time).
   *
   * Returns true on success, false on failure (upload proceeds without a custom cover).
   */
  // Step 1: Open the cover editor modal
  try {
    let editBtn = page.locator('[data-e2e="cover_container"] div.edit-container');
    if (!(await editBtn.isVisible({ timeout: 5000 }))) {
      editBtn = page.locator('div.edit-container:has-text("Edit cover")');
      if (!(await editBtn.isVisible({ timeout: 3000 }))) {
        return false;
      }
    }
    await editBtn.click();
  } catch (e) {
    return false;
  }

  // Step 2: Wait for the frame slider
  try {
    await page.waitForSelector('div.drag-item', { timeout: 8000 });
    await sleep(1000);
  } catch (e) {
    try {
      await page.keyboard.press('Escape');
    } catch (e2) {
      /* ignore */
    }
    return false;
  }

  // Step 3: Drag the slider to the far right (last frame)
  try {
    const dragItem = page.locator('div.drag-item');
    const container = dragItem.locator('..');
    const containerBox = await container.boundingBox();
    const dragBox = await dragItem.boundingBox();

    if (!containerBox || !dragBox) {
      return false;
    }

    const targetX = containerBox.x + containerBox.width - 4;
    const currentX = dragBox.x + dragBox.width / 2;
    const currentY = dragBox.y + dragBox.height / 2;

    await page.mouse.move(currentX, currentY);
    await page.mouse.down();

    // Move in steps — TikTok ignores instant jumps
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(currentX + ((targetX - currentX) * i) / 10, currentY);
      await sleep(50);
    }

    await page.mouse.up();
    await sleep(1000);
  } catch (e) {
    try {
      await page.keyboard.press('Escape');
    } catch (e2) {
      /* ignore */
    }
    return false;
  }

  // Step 4: Confirm
  try {
    const confirmBtn = page.locator('button:has-text("Confirm")').first();
    await confirmBtn.scrollIntoViewIfNeeded();
    await sleep(300);

    try {
      await confirmBtn.click({ timeout: 5000 });
    } catch (e) {
      await confirmBtn.evaluate((el) => el.click());
    }

    await sleep(1500);

    // Wait for the modal to close
    try {
      await page.waitForSelector('div.drag-item', { state: 'hidden', timeout: 5000 });
    } catch (e) {
      /* ignore */
    }

    return true;
  } catch (e) {
    try {
      await page.keyboard.press('Escape');
    } catch (e2) {
      /* ignore */
    }
    return false;
  }
}

async function setVisibility(page, visibility, suppressprint = false) {
  /**
   * Sets the "Who can watch" visibility on the TikTok Studio upload page.
   * Must be called after waitForUploadReady(), before submitUpload().
   *
   * visibility -> 'everyone' | 'friends' | 'private'
   * Returns true if successfully set, false otherwise (non-blocking).
   */
  const labelMap = {
    everyone: 'Everyone',
    friends: 'Friends',
    private: 'Only me',
  };

  const targetLabel = labelMap[`${visibility}`.toLowerCase()] || 'Everyone';

  try {
    // TikTok Studio: click the current visibility selector to open the dropdown
    const openSelectors = [
      'div[data-e2e="permission-container"]',
      'div[class*="PermissionSetting"]',
      'div[class*="permission-item"]:visible',
      'div:has-text("Everyone"):visible',
    ];

    for (const sel of openSelectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          await el.click();
          await sleep(400);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Click the target option
    const optionSelectors = [
      `div[data-e2e="permission-item"]:has-text("${targetLabel}")`,
      `li:has-text("${targetLabel}")`,
      `span:has-text("${targetLabel}")`,
      `div[role="option"]:has-text("${targetLabel}")`,
      `[aria-label="${targetLabel}"]`,
    ];

    for (const sel of optionSelectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0) {
          await el.click();
          await sleep(300);
          if (!suppressprint) {
            console.log(`Visibility set to '${targetLabel}'`);
          }
          return true;
        }
      } catch (e) {
        continue;
      }
    }

    if (!suppressprint) {
      console.log(`Could not set visibility to '${targetLabel}' — proceeding with default`);
    }
    return false;
  } catch (e) {
    if (!suppressprint) {
      console.log(`Visibility error: ${e.message}`);
    }
    return false;
  }
}

/**
 * UPLOADS VIDEO TO TIKTOK (Playwright + stealth)
 * --------------------------------------------------------------------------------
 * @param {string} video path to video to upload
 * @param {string} description description for video
 * @param {string} accountname account to upload on
 * @param {object} [options]
 * @param {string} [options.coverImage]
 *   Path to a PNG/JPG to use as the video cover. The image must already be
 *   baked into the last frame of the video. When provided, the upload flow
 *   opens TikTok's cover editor and drags the frame slider to the last frame
 *   before posting.
 * @param {string[]} [options.hashtags] hashtags for video
 * @param {string} [options.soundName] name of the TikTok sound to use
 * @param {string} [options.soundAudVol] 'main', 'mix' or 'background'
 * @param {string} [options.schedule] 'HH:MM', local time to upload the video
 * @param {number|string} [options.day] day to schedule the video for
 * @param {boolean} [options.copyrightcheck] include the copyright check or not
 * @param {boolean} [options.suppressprint] true means the function prints nothing
 * @param {boolean} [options.headless] run in headless mode or not
 * @param {boolean} [options.stealth] wait extra second(s) before each operation
 * @param {object} [options.proxy] proxy server to run the code on
 * @param {string} [options.searchMode] 'search' or 'favorites'
 * @param {string} [options.visibility] 'everyone' (default), 'friends' or 'private'
 * @returns {Promise<string>} 'Completed' or 'Error'
 */
async function uploadTiktok(
  video,
  description,
  accountname,
  {
    coverImage = null,
    hashtags = null,
    soundName = null,
    soundAudVol = 'mix',
    schedule = null,
    day = null,
    copyrightcheck = false,
    suppressprint = false,
    headless = true,
    stealth = false,
    proxy = null,
    searchMode = 'search',
    visibility = 'everyone',
  } = {}
) {
  try {
    await checkForUpdates();
  } catch (e) {
    await sleep(100);
  }

  try {
    await validateProxy(proxy);
  } catch (e) {
    throw new TikTokUploadError(`Error validating proxy: ${e.message}`);
  }

  if (accountname === null || accountname === undefined) {
    throw new TikTokUploadError(
      'PLEASE ENTER NAME OF ACCOUNT TO POST ON, READ DOCUMENTATION FOR MORE INFO'
    );
  }

  const cookies = await loadOrCreateCookies(accountname, proxy);

  const { browser, context } = await makeStealthContext(headless, proxy);

  try {
    await context.addCookies(cookies);
    const page = await context.newPage();

    const sim = new UserSimulator(page);

    if (!suppressprint) {
      console.log(`Uploading to account '${accountname}'`);
    }

    await gotoWithRetry(page, UPLOAD_URL);
    await sim.simulateBrowsing(1500);

    const captcha = await waitForUploadOrCaptcha(page);
    if (captcha) {
      await solveCaptchaIfNeeded(page, suppressprint);
    }

    await setVideoInput(page, video);
    await addDescriptionAndHashtags(
      page,
      sim,
      video,
      description,
      hashtags,
      stealth,
      suppressprint
    );
    await waitForUploadReady(page);

    await sleep(200);
    if (!suppressprint) {
      console.log('Tik tok done loading file onto servers');
    }

    if (visibility && visibility.toLowerCase() !== 'everyone') {
      await setVisibility(page, visibility, suppressprint);
    }

    await sim.simulateBrowsing(1000);

    [schedule, day] = normalizeScheduleAndDay(schedule, day);
    validateScheduleRequest(schedule, day);
    await applySchedule(page, schedule, day, stealth, suppressprint);

    const soundFail = await addSoundFromUploadPage(
      page,
      soundName,
      soundAudVol,
      sim,
      stealth,
      suppressprint,
      searchMode
    );

    if (!soundFail) {
      await page.waitForSelector('div[data-contents="true"]');

      if (copyrightcheck) {
        await runUploadCopyrightCheck(page, stealth, suppressprint);
      }

      if (coverImage) {
        await selectCoverLastFrame(page);
        await sleep(500);
      }

      const result = await submitUpload(page, schedule, stealth, suppressprint, 0.1, 0.2);
      if (result === 'Error') {
        return 'Error';
      }
    } else {
      try {
        if (stealth) {
          await sleep(1000);
        }
        await page.click('button:has-text("Save draft")', { timeout: 10000 });
        throw new TikTokUploadError(
          'ERROR ADDING SOUND: Video saved as draft, please try again or check documentation for more info'
        );
      } catch (e) {
        throw new TikTokUploadError(
          'ERROR ADDING SOUND; SAVE AS DRAFT BUTTON NOT FOUND SO VIDEO NOT ADDED AS DRAFT'
        );
      }
    }

    return 'Completed';
  } finally {
    try {
      await browser.close();
    } catch (e) {
      /* browser may already be closed */
    }
  }
}

module.exports = {
  uploadTiktok,
  TikTokUploadError,
  // Selectors and helpers exported the way Python exposed module-level names.
  UPLOAD_URL,
  DRAFT_URL,
  CONTENT_URL,

  // Individual steps, exported so the Rust layer can drive the flow through
  // bridge/server.js instead of re-implementing the DOM work.
  checkExpiry,
  readCookies,
  cookieFile,
  loadOrCreateCookies,
  loginWarning,
  makeStealthContext,
  validateProxy,
  gotoWithRetry,
  waitForUploadOrCaptcha,
  solveCaptchaIfNeeded,
  setVideoInput,
  addDescriptionAndHashtags,
  waitForUploadReady,
  setVisibility,
  normalizeScheduleAndDay,
  validateScheduleRequest,
  applySchedule,
  addSoundFromUploadPage,
  runUploadCopyrightCheck,
  selectCoverLastFrame,
  submitUpload,
};
