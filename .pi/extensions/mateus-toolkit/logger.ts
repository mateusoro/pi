import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const LOG_DIR = join(dirname(import.meta.url ?? __dirname, "").replace("file:///", ""), "logs");
mkdirSync(LOG_DIR, { recursive: true });

export function log(level: string, msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;
  const logFile = join(LOG_DIR, `${new Date().toISOString().split("T")[0]}.log`);
  appendFileSync(logFile, line);
  console.error(`[MATEUS-TOOLKIT] ${msg}`);
}
