// Live refresh of the Muvel desktop app after an API write.
//
// The app has no push channel: an open editor only shows server-side changes after it is
// remounted. When Muvel runs with WebView2 remote debugging enabled
// (scripts/launch-muvel-debug.ps1), we connect over the Chrome DevTools Protocol and, if the
// changed document is on screen, remount its route (navigate away and straight back, ~0.3s).
// Without the debug port this is a silent no-op.

const PORT = Number(process.env.MUVEL_CDP_PORT ?? 9333);
// Off by default: remounting the editor from outside once crashed React (removeChild) and the
// app then synced an empty document over the server copy. Opt in with MUVEL_LIVE_REFRESH=1.
const ENABLED = process.env.MUVEL_LIVE_REFRESH === "1";
const APP_ORIGIN = "http://tauri.localhost";
const RETRY_AFTER_MS = 30_000;

interface CdpPage {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

let unreachableUntil = 0;

async function appPages(): Promise<CdpPage[]> {
  if (!ENABLED || Date.now() < unreachableUntil) return [];
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(1500) });
    const pages = (await res.json()) as CdpPage[];
    // Only ever drive the Muvel app itself, never another app that happens to use this port.
    return pages.filter((p) => p.type === "page" && p.url.startsWith(APP_ORIGIN));
  } catch {
    unreachableUntil = Date.now() + RETRY_AFTER_MS;
    return [];
  }
}

function evaluate(wsUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP timeout"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(msg.result?.result?.value);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP connection failed"));
    });
  });
}

// Runs inside the app (idempotent). Tracks the user's content input and the app's own
// blocks/sync requests, so a refresh can tell whether the user has edits not yet on the server.
const INSTALL_SCRIPT = String.raw`(() => {
  if (window.__muvelMcpLiveV2) return "ok";
  const st = (window.__muvelMcpLiveV2 = { lastInput: 0, lastSyncEnd: 0, inflight: 0, installedAt: Date.now() });
  const mark = () => (st.lastInput = Date.now());
  for (const ev of ["input", "compositionend", "paste", "cut", "drop"]) document.addEventListener(ev, mark, true);
  const isSync = (url) => String(url).includes("/blocks/sync");
  const done = () => { st.inflight = Math.max(0, st.inflight - 1); st.lastSyncEnd = Date.now(); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__muvelSync = isSync(url); return open.call(this, method, url, ...rest); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__muvelSync) { st.inflight++; this.addEventListener("loadend", done, { once: true }); }
    return send.apply(this, args);
  };
  const fetch0 = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (!isSync(url)) return fetch0.call(this, input, init);
    st.inflight++;
    return fetch0.call(this, input, init).finally(done);
  };
  return "installed";
})()`;

// Returns "not-open" | "busy" | "blocked" | "refreshed" | "no-router".
const REFRESH_SCRIPT = String.raw`async (ids) => {
  const router = window.__reactRouterDataRouter;
  if (!router) return "no-router";
  const path = location.pathname;
  if (!ids.some((id) => path.includes(id))) return "not-open";
  const st = window.__muvelMcpLiveV2;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Safe to remount once every user edit has reached the server: no sync in flight and no
  // input since the last sync finished. Input that never syncs (typed then undone) counts as
  // settled after 2.5s. Edits made before tracking started are caught by the leave guard below.
  const settled = () => {
    const now = Date.now();
    if (st.inflight > 0) return false;
    return st.lastInput === 0 || st.lastSyncEnd >= st.lastInput || now - st.lastInput > 2500;
  };
  const deadline = Date.now() + 15000;
  for (let attempt = 0; ; attempt++) {
    while (!settled()) {
      if (Date.now() > deadline) return "busy";
      await sleep(50);
    }

    const scrollers = [...document.querySelectorAll("*")]
      .filter((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY))
      .map((e) => ({ cls: e.className, top: e.scrollTop }));
    const docTop = document.scrollingElement ? document.scrollingElement.scrollTop : 0;

    await router.navigate("/", { replace: true });
    const blocked = [...router.state.blockers.values()].filter((b) => b.state === "blocked");
    if (blocked.length || location.pathname === path) {
      // The app refused to leave (unsynced edits). Cancel quietly, let it sync, try again.
      blocked.forEach((b) => b.reset && b.reset());
      if (attempt >= 2 || Date.now() > deadline) return "blocked";
      st.lastInput = Math.max(st.lastInput, Date.now());
      continue;
    }
    await router.navigate(path, { replace: true, preventScrollReset: true });

    for (let i = 0; i < 100 && !document.querySelector("[contenteditable=true]"); i++) await sleep(20);
    await new Promise((r) => requestAnimationFrame(() => r()));
    for (const s of scrollers) {
      const el = [...document.querySelectorAll("*")].find((e) => e.className === s.cls && e.scrollHeight > e.clientHeight + 20);
      if (el) el.scrollTop = s.top;
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = docTop;
    return "refreshed";
  }
}`;

/** Install input/sync tracking in the app ahead of a write. Never throws. */
export async function primeApp(): Promise<void> {
  for (const page of await appPages()) {
    await evaluate(page.webSocketDebuggerUrl, INSTALL_SCRIPT, 5_000).catch(() => {});
  }
}

/**
 * If the Muvel app is showing a page whose path contains any of `ids`, remount it so the
 * change made through the API appears. Returns a short note for the tool result ("" when
 * live refresh is unavailable or the document isn't open).
 */
export async function refreshApp(ids: string[]): Promise<string> {
  const pages = await appPages();
  const results: unknown[] = [];
  for (const page of pages) {
    try {
      await evaluate(page.webSocketDebuggerUrl, INSTALL_SCRIPT, 5_000);
      results.push(await evaluate(page.webSocketDebuggerUrl, `(${REFRESH_SCRIPT})(${JSON.stringify(ids)})`, 25_000));
    } catch {
      // A failed refresh must never turn a successful save into an error.
    }
  }
  if (results.includes("refreshed")) return " 열려 있는 Muvel 앱 화면도 새로고침했습니다.";
  if (results.includes("busy")) return " Muvel 앱에서 입력이 계속되고 있어 앱 화면 새로고침은 건너뛰었습니다(서버에는 저장됨).";
  if (results.includes("blocked")) return " Muvel 앱에 아직 저장되지 않은 입력이 있어 앱 화면 새로고침은 건너뛰었습니다(서버에는 저장됨).";
  return "";
}
