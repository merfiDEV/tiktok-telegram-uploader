/**
 * Human-like input simulator.
 *
 * JavaScript equivalent of Phantomwright's SyncUserSimulator, which the Python
 * version of this library relied on. It offers the operations used by the
 * upload flow: simulateBrowsing(), prepareForInteraction(), click() and type().
 */

function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

class UserSimulator {
  /**
   * @param {import('playwright').Page} page
   * @param {object} [options]
   * @param {number} [options.minDelay] minimum per-character/per-step delay in ms
   * @param {number} [options.maxDelay] maximum per-character/per-step delay in ms
   * @param {number} [options.moveSteps] number of mouse move steps
   */
  constructor(page, options = {}) {
    this.page = page;
    this.minDelay = options.minDelay ?? 40;
    this.maxDelay = options.maxDelay ?? 120;
    this.moveSteps = options.moveSteps ?? 12;
    this._lastPosition = { x: 0, y: 0 };
  }

  async _pause() {
    await sleep(randomBetween(this.minDelay, this.maxDelay));
  }

  async _moveMouseTo(x, y, steps = this.moveSteps) {
    const startX = this._lastPosition.x;
    const startY = this._lastPosition.y;

    for (let i = 1; i <= steps; i++) {
      const nextX = startX + ((x - startX) * i) / steps;
      const nextY = startY + ((y - startY) * i) / steps;
      await this.page.mouse.move(nextX, nextY);
      await sleep(randomBetween(5, 25));
    }

    this._lastPosition = { x, y };
  }

  /**
   * Scrolls an element into view and hovers slightly off-center over it.
   * @param {import('playwright').Locator} locator
   */
  async prepareForInteraction(locator) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    } catch (e) {
      /* element may already be in view or detached */
    }

    try {
      const box = await locator.boundingBox();
      if (box) {
        const x = box.x + box.width * (0.35 + Math.random() * 0.3);
        const y = box.y + box.height * (0.35 + Math.random() * 0.3);
        await this._moveMouseTo(x, y);
        await this._pause();
      }
    } catch (e) {
      /* hover is best-effort */
    }
  }

  /**
   * Clicks an element the way a person would: scroll, move, small pause, click.
   * @param {import('playwright').Locator} locator
   */
  async click(locator) {
    await this.prepareForInteraction(locator);

    try {
      const box = await locator.boundingBox();
      if (box) {
        const x = box.x + box.width * (0.4 + Math.random() * 0.2);
        const y = box.y + box.height * (0.4 + Math.random() * 0.2);
        await this.page.mouse.click(x, y);
        this._lastPosition = { x, y };
        return;
      }
    } catch (e) {
      /* fall through to locator click */
    }

    await locator.click();
  }

  /**
   * Types text character by character with human-like timing.
   * @param {import('playwright').Locator} locator
   * @param {string} text
   */
  async type(locator, text) {
    try {
      await locator.click();
    } catch (e) {
      /* typing may still work without the focus click */
    }

    for (const char of text) {
      if (char === '\n') {
        await this.page.keyboard.press('Enter');
      } else {
        await this.page.keyboard.type(char);
      }
      await this._pause();

      // Occasional longer pause, like a person re-reading what they typed.
      if (Math.random() < 0.05) {
        await sleep(randomBetween(200, 600));
      }
    }
  }

  /**
   * Idles on the page with small mouse movements and scrolls.
   * @param {number} [durationMs]
   */
  async simulateBrowsing(durationMs = 1000) {
    const endTime = Date.now() + durationMs;
    let x = randomBetween(200, 900);
    let y = randomBetween(200, 700);

    while (Date.now() < endTime) {
      x += randomBetween(-80, 80);
      y += randomBetween(-60, 60);
      x = Math.max(10, Math.min(1270, x));
      y = Math.max(10, Math.min(890, y));

      await this._moveMouseTo(x, y, 4);
      await sleep(randomBetween(50, 180));

      if (Math.random() < 0.15) {
        await this.page.mouse.wheel(0, randomBetween(50, 200));
      }
    }
  }
}

module.exports = { UserSimulator };
