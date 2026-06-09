import fs from 'fs';

let logStream: fs.WriteStream | null = null;

export function initLogger(logFile?: string): void {
  if (!logFile) return;
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.on('error', (err) => {
    process.stderr.write(`Failed to write to log file: ${err.message}\n`);
  });
}

export function log(level: string, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [minecraft] [mcp-server] [${level}] ${message}\n`;
  process.stderr.write(line);
  logStream?.write(line);
}