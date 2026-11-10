// Execute one wire request directly in the page's MAIN world. Returning the
// structured response through executeScript avoids a fragile postMessage hop.
export async function executePageRequest(request) {
  // The Plugin API calls the wire protocol defines (src/types/wire.ts
  // WireMethod). Kept inside this function because executeScript serializes
  // it into the page without its module scope.
  const PLUGIN_METHODS = ["exportData", "updateAccount", "restoreCurrentFinances", "restorePlans", "restoreProgress", "restoreSettings", "validateApiKey"];
  function waitForApi(timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (window.projectionlabPluginAPI) return resolve(window.projectionlabPluginAPI);
        if (Date.now() >= deadline) return reject(Object.assign(new Error(`ProjectionLab Plugin API did not appear within ${Math.round(timeoutMs / 1000)} seconds`), { code: "API_NOT_AVAILABLE" }));
        setTimeout(poll, 500);
      };
      poll();
    });
  }

  function classifyError(error) {
    if (error?.code === "API_NOT_AVAILABLE") return "API_NOT_AVAILABLE";
    const message = error instanceof Error ? error.message : String(error);
    return /api.?key|invalid key|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(message) ? "API_KEY_INVALID" : "UNKNOWN";
  }

  try {
    if (request.method !== "waitForApi" && request.method !== "describeApi" && !PLUGIN_METHODS.includes(request.method)) {
      throw new Error(`Not a wire protocol method: ${request.method}`);
    }
    const requested = request.method === "waitForApi" ? Number(request.params?.[0]) : NaN;
    const api = await waitForApi(Number.isFinite(requested) && requested > 0 ? requested : 15_000);
    let result;
    if (request.method === "waitForApi") result = true;
    else if (request.method === "describeApi") {
      result = {};
      const seen = new Set();
      let object = api;
      while (object && object !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(object)) {
          if (key === "constructor" || seen.has(key)) continue;
          seen.add(key);
          const value = api[key];
          result[key] = typeof value === "function" ? `function(${value.length} args)` : typeof value;
        }
        object = Object.getPrototypeOf(object);
      }
    } else {
      const operation = api[request.method];
      if (typeof operation !== "function") throw new Error(`Plugin API method is unavailable: ${request.method}`);
      result = await operation.apply(api, request.params);
    }
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: { code: classifyError(error), message: error instanceof Error ? error.message : String(error) },
    };
  }
}
