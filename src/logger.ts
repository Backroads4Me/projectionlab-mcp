import { config } from "./config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function timestamp(): string {
  return new Date().toISOString();
}

export const log = {
  error(op: string, msg: string) {
    if (threshold >= LEVELS.error)
      console.error(`[${timestamp()}] ERROR [${op}] ${msg}`);
  },
  warn(op: string, msg: string) {
    if (threshold >= LEVELS.warn)
      console.error(`[${timestamp()}] WARN  [${op}] ${msg}`);
  },
  info(op: string, msg: string) {
    if (threshold >= LEVELS.info)
      console.error(`[${timestamp()}] INFO  [${op}] ${msg}`);
  },
  debug(op: string, msg: string) {
    if (threshold >= LEVELS.debug)
      console.error(`[${timestamp()}] DEBUG [${op}] ${msg}`);
  },
};
