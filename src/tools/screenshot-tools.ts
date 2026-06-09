import { createRequire } from 'module';
import type { Browser, Page } from 'puppeteer-core';
import { ToolFactory, McpResponse } from '../tool-factory.js';
import { log } from '../logger.js';

const require = createRequire(import.meta.url);

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

let browser: Browser | null = null;
let page: Page | null = null;
let loadedViewerUrl = '';

async function findChrome(): Promise<string> {
  const fs = await import('fs');
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `No Chrome/Chromium found. Tried: ${CHROME_PATHS.join(', ')}`
  );
}

async function getPage(viewerUrl: string): Promise<Page> {
  const puppeteer = require('puppeteer-core');

  const needsReload = !page || loadedViewerUrl !== viewerUrl;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!browser || !(browser as any).connected) {
    if (browser) {
      try { await (browser as Browser).close(); } catch { /* ignore */ }
    }
    const executablePath = await findChrome();
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    log('info', 'Puppeteer browser launched for screenshots');
  }

  if (needsReload || !page) {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
    page = await browser!.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(viewerUrl, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.waitForSelector('canvas', { timeout: 10000 });
    // Let the world chunks load and render
    await new Promise(r => setTimeout(r, 4000));
    loadedViewerUrl = viewerUrl;
    log('info', 'Viewer page loaded in puppeteer');
  }

  return page;
}

export async function captureScreenshot(getViewerPort: () => number): Promise<string | null> {
  const port = getViewerPort();
  if (port === 0) return null;
  try {
    const pg = await getPage(`http://localhost:${port}`);
    await new Promise(r => setTimeout(r, 500));
    return await pg.screenshot({ encoding: 'base64', type: 'png' }) as string;
  } catch (err) {
    log('warn', `Screenshot capture failed: ${(err as Error).message}`);
    return null;
  }
}

export function registerScreenshotTools(factory: ToolFactory, getViewerPort: () => number): void {
  factory.registerTool(
    'take-screenshot',
    'Take a screenshot of the current game view. Returns an image showing the world around the bot. The first call after connecting takes ~5 seconds to load; subsequent calls are fast.',
    {},
    async (): Promise<McpResponse> => {
      const port = getViewerPort();
      if (port === 0) {
        return factory.createResponse(
          'Viewer is not running. Start the server with --viewer-port <port> (e.g. --viewer-port 3007) to enable screenshots.'
        );
      }

      const data = await captureScreenshot(getViewerPort);
      if (!data) {
        return factory.createResponse('Screenshot failed — viewer may still be loading. Try again in a moment.');
      }

      return {
        content: [{ type: 'image', data, mimeType: 'image/png' }],
      };
    }
  );
}

export async function closeScreenshotBrowser(): Promise<void> {
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    page = null;
    loadedViewerUrl = '';
  }
}
