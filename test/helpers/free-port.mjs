// Asks the OS for a free TCP port: binds an ephemeral listener on
// 127.0.0.1 port 0, reads the assigned port, closes the listener, and
// returns the port. Callers pass it as PL_WS_PORT before importing the
// bridge, so concurrent `npm test` runs never collide on a fixed port.
// A small window exists between closing the probe and the caller binding;
// if another process claims the port in that window the test fails, which
// is accepted over adding retries.

import { createServer } from "node:net";

/** Resolves with a port that is free to bind on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
