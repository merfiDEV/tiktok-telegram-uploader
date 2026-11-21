/**
 * Shared browser engine.
 *
 * Playwright with the puppeteer-extra stealth evasions applied once, so both
 * the login flow and the upload flow launch the same hardened browser.
 */

const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(stealthPlugin());

module.exports = { chromium };
