import { createRequire } from 'module';
import type { Bot } from 'mineflayer';
import { log } from './logger.js';

const require = createRequire(import.meta.url);

let viewerPort = 0;
let viewerStarted = false;
let closeHandle: (() => void) | null = null;

export function startViewer(bot: Bot, port: number): void {
  if (port === 0) return;
  if (viewerStarted) return;

  viewerPort = port;
  viewerStarted = true;

  try {
    const { mineflayer: prismarineViewer } = require('prismarine-viewer');
    prismarineViewer(bot, { port, firstPerson: true, viewDistance: 6 });
    // prismarine-viewer attaches bot.viewer.close — store it for cleanup
    closeHandle = () => {
      try {
        (bot as unknown as { viewer?: { close: () => void } }).viewer?.close();
      } catch { /* ignore */ }
    };
    log('info', `Prismarine viewer started at http://localhost:${port}`);
  } catch (err) {
    log('error', `Failed to start prismarine viewer: ${(err as Error).message}`);
    viewerStarted = false;
  }
}

export function getViewerPort(): number {
  return viewerStarted ? viewerPort : 0;
}

export function closeViewer(): void {
  if (closeHandle) {
    closeHandle();
    closeHandle = null;
    log('info', 'Prismarine viewer closed');
  }
  viewerStarted = false;
}
