import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  logFile?: string;
  viewerPort: number;
}

export function parseConfig(): ServerConfig {
  return yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('log-file', {
      type: 'string',
      description: 'Path to a log file (logs are always written to stderr; this adds a file)',
    })
    .option('viewer-port', {
      type: 'number',
      description: 'Port for the prismarine-viewer web server (0 to disable, default: 3007)',
      default: 3007,
    })
    .help()
    .alias('help', 'h')
    .parseSync();
}
