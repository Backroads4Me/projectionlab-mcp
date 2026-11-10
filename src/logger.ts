import { config } from "./config.js";
import { redactSecrets } from "./redact.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function timestamp(): string {
  return new Date().toISOString();
}

// Messages often carry an error from the browser executor, which can echo
// request data. Every line is scrubbed here so no call site can log the
// Plugin API key.
function write(label: string, op: string, msg: string): void {
  console.error(`[${timestamp()}] ${label} [${op}] ${redactSecrets(msg)}`);
}

export const log = {
  error(op: string, msg: string) {
    if (threshold >= LEVELS.error) write("ERROR", op, msg);
  },
  warn(op: string, msg: string) {
    if (threshold >= LEVELS.warn) write("WARN ", op, msg);
  },
  info(op: string, msg: string) {
    if (threshold >= LEVELS.info) write("INFO ", op, msg);
  },
  debug(op: string, msg: string) {
    if (threshold >= LEVELS.debug) write("DEBUG", op, msg);
  },
};
