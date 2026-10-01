// Live refresh of the Muvel desktop app after an API write.
//
// The app has no push channel: an open editor only shows server-side changes after it is
// remounted. When Muvel runs with WebView2 remote debugging enabled
// (scripts/launch-muvel-debug.ps1), we connect over the Chrome DevTools Protocol and, if the
// changed document is on screen, remount its route (navigate away and straight back, ~0.3s).
// Without the debug port this is a silent no-op.

const PORT = Number(process.env.MUVEL_CDP_PORT ?? 9333);
const ENABLED = process.env.MUVEL_LIVE_REFRESH !== "0";
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

// Runs inside the app. Returns "not-open" | "busy" | "blocked" | "refreshed" | "no-router".
const PAGE_SCRIPT = String.raw`async (ids) => {
  const router = window.__reactRouterDataRouter;
  if (!router) return "no-router";
  const path = location.pathname;
  if (!ids.some((id) => path.includes(id))) return "not-open";

  // Track the user's typing so we only remount after the app has synced their edits
  // (it syncs ~1s after input stops). The listener survives across calls.
  const st = (window.__muvelMcpLive ??= { lastInput: 0, installedAt: Date.now() });
  if (!st.listening) {
    const mark = () => (st.lastInput = Date.now());
    for (const ev of ["input", "keydown", "compositionupdate", "paste", "cut"]) document.addEventListener(ev, mark, true);
    st.listening = true;
  }
  const quietFor = () => Date.now() - Math.max(st.lastInput, st.installedAt);
  const deadline = Date.now() + 15000;
  while (quietFor() < 2500) {
    if (Date.now() > deadline) return "busy";
    await new Promise((r) => setTimeout(r, 200));
  }

  const scrollers = [...document.querySelectorAll("*")]
    .filter((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY))
    .map((e) => ({ cls: e.className, top: e.scrollTop }));
  const docTop = document.scrollingElement ? document.scrollingElement.scrollTop : 0;

  await router.navigate("/", { replace: true });
  const blocked = [...router.state.blockers.values()].filter((b) => b.state === "blocked");
  if (blocked.length || location.pathname === path) {
    // The app refused to leave (unsynced edits): cancel quietly and leave the screen as is.
    blocked.forEach((b) => b.reset && b.reset());
    return "blocked";
  }
  await router.navigate(path, { replace: true, preventScrollReset: true });

  for (let i = 0; i < 50 && !document.querySelector("[contenteditable=true]"); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => requestAnimationFrame(() => r()));
  for (const s of scrollers) {
    const el = [...document.querySelectorAll("*")].find((e) => e.className === s.cls && e.scrollHeight > e.clientHeight + 20);
    if (el) el.scrollTop = s.top;
  }
  if (document.scrollingElement) document.scrollingElement.scrollTop = docTop;
  return "refreshed";
}`;

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
      results.push(await evaluate(page.webSocketDebuggerUrl, `(${PAGE_SCRIPT})(${JSON.stringify(ids)})`, 25_000));
    } catch {
      // A failed refresh must never turn a successful save into an error.
    }
  }
  if (results.includes("refreshed")) return " 열려 있는 Muvel 앱 화면도 새로고침했습니다.";
  if (results.includes("busy")) return " Muvel 앱에서 입력이 계속되고 있어 앱 화면 새로고침은 건너뛰었습니다(서버에는 저장됨).";
  if (results.includes("blocked")) return " Muvel 앱에 아직 저장되지 않은 입력이 있어 앱 화면 새로고침은 건너뛰었습니다(서버에는 저장됨).";
  return "";
}
