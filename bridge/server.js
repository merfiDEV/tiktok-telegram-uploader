#!/usr/bin/env node
'use strict';

/**
 * JSON-lines RPC bridge for the Rust layer.
 *
 * The stealth browser (playwright-extra + puppeteer-extra-plugin-stealth) has
 * no Rust equivalent, so it stays here. This process owns the browser handles
 * and exposes each step of the upload flow as a request/response method, so the
 * Rust side can orchestrate the whole flow without touching the DOM.
 *
 * Protocol: one JSON object per line on stdin, one per line on stdout.
 *   -> {"id":1,"method":"launch","params":{"headless":true}}
 *   <- {"id":1,"ok":true,"result":null}
 *   <- {"id":1,"ok":false,"error":{"name":"TikTokUploadError","message":"..."}}
 *
 * stdout carries the protocol only: every console.log from the library is
 * rerouted to stderr, where the Rust side forwards it to the user.
 */

const readline = require('readline');

const api = require('../tiktokautouploader/function');
const { login } = require('../tiktokautouploader/login');
const { UserSimulator } = require('../tiktokautouploader/userSimulator');

// The library logs progress with console.log; keep stdout clean for the wire.
console.log = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
};
console.info = console.log;
console.warn = console.log;

const state = {
  browser: null,
  context: null,
  page: null,
  sim: null,
};

function need(what) {
  if (!state[what]) {
    throw new Error(`bridge: ${what} is not available; call the earlier step first`);
  }
  return state[what];
}

const methods = {
  ping: async () => 'pong',

  // --- cookies / login -----------------------------------------------------
  login: async ({ proxy = null } = {}) => {
    await login(proxy);
    return null;
  },

  // --- browser -------------------------------------------------------------
  launch: async ({ headless = true, proxy = null } = {}) => {
    const { browser, context } = await api.makeStealthContext(headless, proxy);
    state.browser = browser;
    state.context = context;
    return null;
  },

  validateProxy: async ({ proxy = null } = {}) => {
    await api.validateProxy(proxy);
    return null;
  },

  addCookies: async ({ cookies }) => {
    await need('context').addCookies(cookies);
    return null;
  },

  newPage: async () => {
    state.page = await need('context').newPage();
    state.sim = new UserSimulator(state.page);
    return state.page.url();
  },

  goto: async ({ url }) => {
    await api.gotoWithRetry(need('page'), url);
    return null;
  },

  simulateBrowsing: async ({ ms = 1000 } = {}) => {
    if (state.sim) {
      await state.sim.simulateBrowsing(ms);
    }
    return null;
  },

  // --- upload flow ---------------------------------------------------------
  waitForUploadOrCaptcha: async () => api.waitForUploadOrCaptcha(need('page')),

  solveCaptcha: async ({ suppressprint = false } = {}) => {
    await api.solveCaptchaIfNeeded(need('page'), suppressprint);
    return null;
  },

  setVideo: async ({ video }) => {
    await api.setVideoInput(need('page'), video);
    return null;
  },

  descHashtags: async ({
    video,
    description,
    hashtags = null,
    stealth = false,
    suppressprint = false,
  }) => {
    await api.addDescriptionAndHashtags(
      need('page'),
      need('sim'),
      video,
      description,
      hashtags,
      stealth,
      suppressprint
    );
    return null;
  },

  waitForUploadReady: async () => {
    await api.waitForUploadReady(need('page'));
    return null;
  },

  setVisibility: async ({ visibility, suppressprint = false } = {}) => {
    await api.setVisibility(need('page'), visibility, suppressprint);
    return null;
  },

  applySchedule: async ({ schedule, day = null, stealth = false, suppressprint = false } = {}) => {
    await api.applySchedule(need('page'), schedule, day, stealth, suppressprint);
    return null;
  },

  addSound: async ({
    soundName = null,
    soundAudVol = 'mix',
    stealth = false,
    suppressprint = false,
    searchMode = 'search',
  } = {}) =>
    api.addSoundFromUploadPage(
      need('page'),
      soundName,
      soundAudVol,
      state.sim,
      stealth,
      suppressprint,
      searchMode
    ),

  copyrightCheck: async ({ stealth = false, suppressprint = false } = {}) => {
    await api.runUploadCopyrightCheck(need('page'), stealth, suppressprint);
    return null;
  },

  selectCover: async () => {
    await api.selectCoverLastFrame(need('page'));
    return null;
  },

  submit: async ({
    schedule = null,
    stealth = false,
    suppressprint = false,
    postSuccessWait = 0.1,
    scheduleSuccessWait = 0.2,
  } = {}) =>
    api.submitUpload(
      need('page'),
      schedule,
      stealth,
      suppressprint,
      postSuccessWait,
      scheduleSuccessWait
    ),

  saveDraft: async () => {
    await need('page').click('button:has-text("Save draft")', { timeout: 10000 });
    return null;
  },

  close: async () => {
    try {
      if (state.browser) {
        await state.browser.close();
      }
    } catch (e) {
      /* the browser may already be gone */
    }
    state.browser = null;
    state.context = null;
    state.page = null;
    state.sim = null;
    return null;
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(line) {
  let request;

  try {
    request = JSON.parse(line);
  } catch (e) {
    send({ id: null, ok: false, error: { name: 'ProtocolError', message: 'invalid JSON' } });
    return;
  }

  const { id, method, params = {} } = request;
  const handler = methods[method];

  if (!handler) {
    send({ id, ok: false, error: { name: 'ProtocolError', message: `unknown method '${method}'` } });
    return;
  }

  try {
    const result = await handler(params);
    send({ id, ok: true, result });
  } catch (e) {
    send({
      id,
      ok: false,
      error: { name: e && e.name ? e.name : 'Error', message: e && e.message ? e.message : String(e) },
    });
  }
}

// Requests are handled one at a time so browser state cannot interleave.
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') {
    return;
  }
  queue = queue.then(() => handle(trimmed));
});

rl.on('close', () => {
  queue.then(() => {
    methods.close().finally(() => process.exit(0));
  });
});

process.stderr.write('tiktokautouploader bridge ready\n');
