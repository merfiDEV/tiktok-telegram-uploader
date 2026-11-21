/**
 * First-time login flow.
 *
 * JavaScript port of Js_assets/login.js, which the Python library invoked as a
 * child process. It opens a visible browser, waits for the manual login to
 * redirect to the feed, then writes TK_cookies.json to the working directory.
 */

const fs = require('fs');

const { chromium } = require('./browser');

function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

async function checkForRedirect(page) {
  const currentUrl = page.url();
  const pattern = /^https:\/\/www\.tiktok\.com\/foryou/;
  return pattern.test(currentUrl);
}

/**
 * @param {object|null} proxyData {'server', 'username'?, 'password'?}
 */
async function login(proxyData = null) {
  const browserOptions = {
    headless: false,
  };

  if (proxyData && proxyData.server) {
    browserOptions.proxy = {
      server: proxyData.server,
      username: proxyData.username || undefined,
      password: proxyData.password || undefined,
    };
  }

  const browser = await chromium.launch(browserOptions);

  try {
    const page = await browser.newPage();
    await page.goto('https://www.tiktok.com/login');

    let redirected = false;
    while (!redirected) {
      redirected = await checkForRedirect(page);
      if (!redirected) {
        await sleep(1000);
      }
    }

    await sleep(2000);
    const cookies = await page.context().cookies();
    fs.writeFileSync('TK_cookies.json', JSON.stringify(cookies, null, 2));
  } finally {
    await browser.close();
  }
}

module.exports = { login };
