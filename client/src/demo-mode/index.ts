// Demo mode — fully static, backend-free build of the dashboard.
//
// Built with `vite --mode demo`, so `import.meta.env.MODE === "demo"` is the
// single source of truth. There is no server: a few real sessions are frozen
// into static JSON under /demo/data by `npm run demo:freeze`, and the fetch
// shim below maps every /api/* request to its mirrored static file. This keeps
// the entire app (api.ts, the proxy components, lazy per-call loads) working
// unchanged behind one network-layer seam, instead of threading a data-source
// prop through ~30 call sites.

export const IS_DEMO = import.meta.env.MODE === "demo";

const DATA_BASE = "/demo/data";

/** Resolve the URL string from any fetch() input form (string | URL | Request). */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && !(input instanceof URL) && "method" in input) {
    return (input as Request).method.toUpperCase();
  }
  return "GET";
}

/** /api/v2/sessions/:id/drilldown  ->  /demo/data/v2/sessions/:id/drilldown.json */
function apiToStatic(pathname: string): string {
  return DATA_BASE + pathname.replace(/^\/api/, "") + ".json";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Install the demo fetch shim. Idempotent. Call once at bootstrap, before the
 * first render, so the very first data fetch already hits the static layer.
 */
export function installDemoFetch(): void {
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = urlOf(input);
    let pathname: string;
    try {
      pathname = new URL(raw, window.location.origin).pathname;
    } catch {
      return realFetch(input, init);
    }

    // Only /api/* is virtualized; static assets (/assets, /demo/data, …) pass through.
    if (!pathname.startsWith("/api/")) return realFetch(input, init);

    // Mutations (proxy start/stop/sync/whitelist) have no static equivalent —
    // acknowledge with a no-op so the UI doesn't error.
    if (methodOf(input, init) !== "GET") return jsonResponse({ ok: true, demo: true });

    const res = await realFetch(apiToStatic(pathname));
    // A frozen endpoint that wasn't captured (e.g. team for a non-team session,
    // or a call left out of the freeze) surfaces as a real 404, which every
    // caller already handles (sets null / shows its empty state).
    if (res.status === 404) return jsonResponse({ error: "not_in_demo", path: pathname }, 404);
    return res;
  };
}
