// Execute one wire request directly in the page's MAIN world. Returning the
// structured response through executeScript avoids a fragile postMessage hop.
export async function executePageRequest(request) {
  function waitForApi() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = () => {
        if (window.projectionlabPluginAPI) return resolve(window.projectionlabPluginAPI);
        if (Date.now() >= deadline) return reject(Object.assign(new Error("ProjectionLab Plugin API did not appear within 15 seconds"), { code: "API_NOT_AVAILABLE" }));
        setTimeout(poll, 500);
      };
      poll();
    });
  }

  function classifyError(error) {
    if (error?.code === "API_NOT_AVAILABLE") return "API_NOT_AVAILABLE";
    const message = error instanceof Error ? error.message : String(error);
    return /api.?key|invalid key|unauthori[sz]ed|forbidden|401|403/i.test(message) ? "API_KEY_INVALID" : "UNKNOWN";
  }

  try {
    const api = await waitForApi();
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
