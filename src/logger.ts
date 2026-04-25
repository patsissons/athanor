import { createWriteStream, WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import chalk from "chalk";

let fileStream: WriteStream | null = null;
let debugEnabled = false;

export function enableDebug(): void {
  debugEnabled = true;
}

function ts(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string, color: (s: string) => string) {
  const line = `${ts()} [${level}] ${msg}`;
  console.log(color(line));
  fileStream?.write(line + "\n");
}

export const log = {
  info: (msg: string) => write("INFO", msg, chalk.white),
  warn: (msg: string) => write("WARN", msg, chalk.yellow),
  error: (msg: string) => write("ERROR", msg, chalk.red),
  debug: (msg: string) => {
    const line = `${ts()} [DEBUG] ${msg}`;
    // Always write to file, only show on console when --debug is active
    fileStream?.write(line + "\n");
    if (debugEnabled) {
      console.log(chalk.gray(line));
    }
  },
};

export async function setupLogging(runDir: string): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = `${runDir}/run-${stamp}.log`;
  fileStream = createWriteStream(logFile, { flags: "a" });
  return logFile;
}
