import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

type JobKind = "search" | "tweet";
type SearchType = "Top" | "Latest";

type CDPTab = {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type Tweet = {
  id: string;
  text: string;
  created_at?: string;
  user: {
    id: string;
    name: string;
    screen_name: string;
  };
  favorite_count: number;
  retweet_count: number;
  reply_count: number;
  quote_count: number;
  view_count: number | null;
  lang?: string;
  is_reply: boolean;
  conversation_id: string;
  url: string | null;
};

type Job = {
  id: string;
  kind: JobKind;
  q: string;
  type: SearchType;
  tweet_id: string;
  createdAt: number;
  done: boolean;
  result: Tweet[] | null;
  raw: unknown;
  promise: Promise<void>;
  resolve: () => void;
};

type JobFields = {
  kind: JobKind;
  q: string;
  type: SearchType;
  tweet_id: string;
};

type CaptureEntry = Record<string, unknown>;
type AnyRecord = Record<string, unknown>;

const log = {
  info: (...args: unknown[]) => console.info(new Date().toISOString(), "[INFO]", ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), "[WARN]", ...args),
  error: (...args: unknown[]) => console.error(new Date().toISOString(), "[ERROR]", ...args),
};

const CDP_BASE = (process.env.XBRIDGE_CDP_BASE || "http://127.0.0.1:18800").replace(/\/$/, "");
const START_BRIDGE_SCRIPT = process.env.XBRIDGE_START_SCRIPT || "";
const BROWSER_PROFILE_DIR = process.env.XBRIDGE_BROWSER_PROFILE_DIR || "";
const IDLE_STOP_AFTER = numberEnv("XBRIDGE_IDLE_SECONDS", 600);
const IDLE_CHECK_INTERVAL = numberEnv("XBRIDGE_IDLE_CHECK_SECONDS", 60);
const WAKE_TIMEOUT = numberEnv("XBRIDGE_WAKE_TIMEOUT", 240);
const CDP_TIMEOUT = numberEnv("XBRIDGE_CDP_TIMEOUT", 8);
const POLL_READY_TIMEOUT = numberEnv("XBRIDGE_POLL_READY_TIMEOUT", 150);
const ABORT_GRACE_SECONDS = numberEnv("XBRIDGE_ABORT_GRACE_SECONDS", 20);
const BRIDGE_READY_SECONDS = numberEnv("XBRIDGE_BRIDGE_READY_SECONDS", 15);
const EXTRA_PATH = process.env.XBRIDGE_EXTRA_PATH || "";
const POWER_GUARD = process.env.XBRIDGE_POWER_GUARD === "1";
const POWER_AC_DEVICE = process.env.XBRIDGE_POWER_AC_DEVICE || "AC";
const POWER_BATTERY_DEVICE = process.env.XBRIDGE_POWER_BATTERY_DEVICE || "BAT0";
const MIN_BATTERY_FOR_BROWSER = numberEnv("XBRIDGE_MIN_BATTERY_FOR_BROWSER", 5);
const STALE_AFTER = 300;
const RECENT_LIMIT = 10;

const PAGE_BRIDGE_SCRIPT = String.raw`
(() => {
  'use strict';
  if (window.__xBridgeInstalled) window.__xBridgeInterceptorsInstalled = true;

  const LOCAL = 'http://127.0.0.1:19816';
  const CAPTURE_OPS = ['SearchTimeline', 'UserTweets', 'UserTweetsAndReplies', 'HomeTimeline', 'HomeLatestTimeline', 'TweetDetail'];
  const POLL_MS = 5000;
  const WATCHDOG_MS = 75000;

  const params = new URLSearchParams(location.search);
  const bridgeOn = params.has('bridge');
  if (bridgeOn) sessionStorage.setItem('claw_bridge', '1');
  const IS_BRIDGE = sessionStorage.getItem('claw_bridge') === '1';
  const JOBID = params.get('jobid') || null;

  const opFrom = (u) => {
    const m = String(u).match(/\/i\/api\/graphql\/[^/]+\/([A-Za-z0-9_]+)/);
    return m ? m[1] : null;
  };

  const apiPost = (path, body) => fetch(LOCAL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);

  const apiGet = async (path) => {
    try {
      const r = await fetch(LOCAL + path);
      return await r.json();
    } catch (_) {
      return null;
    }
  };

  const emit = (op, url, body) => {
    console.log('[x-bridge] capture', op, (body || '').length, 'bytes');
    apiPost('/captured', { op, url, body, jobid: JOBID, captured_at: new Date().toISOString() });
  };

  if (!window.__xBridgeInterceptorsInstalled) {
    try {
      window.__xBridgeInterceptorsInstalled = true;
      window.__xBridgeInstalled = true;
      const origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const op = opFrom(url);
        const p = origFetch(input, init);
        if (op && CAPTURE_OPS.includes(op)) {
          p.then((resp) => {
            try { resp.clone().text().then((t) => emit(op, url, t)).catch(() => {}); } catch (_) {}
          }).catch(() => {});
        }
        return p;
      };

      const OrigXHR = window.XMLHttpRequest;
      function PatchedXHR() {
        const xhr = new OrigXHR();
        let xhrUrl = '';
        const origOpen = xhr.open;
        xhr.open = function (m, u) { xhrUrl = u; return origOpen.apply(xhr, arguments); };
        xhr.addEventListener('load', function () {
          const op = opFrom(xhrUrl);
          if (op && CAPTURE_OPS.includes(op)) {
            try { emit(op, xhrUrl, xhr.responseText); } catch (_) {}
          }
        });
        return xhr;
      }
      PatchedXHR.prototype = OrigXHR.prototype;
      window.XMLHttpRequest = PatchedXHR;
      console.log('[x-bridge] CDP interceptors installed');
    } catch (e) {
      console.error('[x-bridge] failed to install CDP bridge:', e);
    }
  }

  if (!IS_BRIDGE) return;
  if (window.__xBridgePollerInstalled) return;
  window.__xBridgePollerInstalled = true;
  console.log('[x-bridge] bridge mode, jobid=', JOBID);

  if (JOBID) {
    let finished = false;
    const watchdog = setTimeout(() => {
      if (finished) return;
      console.log('[x-bridge] watchdog fired, aborting + home');
      apiPost('/abort', { jobid: JOBID }).finally(() => { location.href = '/home?bridge=1'; });
    }, WATCHDOG_MS);
    const poll = setInterval(async () => {
      const j = await apiGet('/queries');
      if (!j) return;
      const stillPending = Array.isArray(j.queue) && j.queue.some((q) => q.id === JOBID);
      if (!stillPending) {
        finished = true;
        clearInterval(poll);
        clearTimeout(watchdog);
        console.log('[x-bridge] job done, home');
        setTimeout(() => { location.href = '/home?bridge=1'; }, 300);
      }
    }, 2000);
  } else {
    setTimeout(function tick() {
      apiGet('/queries').then((j) => {
        if (j && Array.isArray(j.queue) && j.queue.length) {
          const job = j.queue[0];
          let target;
          if (job.kind === 'search') {
            const f = job.type === 'Latest' ? 'live' : 'top';
            target = '/search?q=' + encodeURIComponent(job.q) + '&src=typed_query&f=' + f + '&bridge=1&jobid=' + encodeURIComponent(job.id);
          } else if (job.kind === 'tweet') {
            target = '/i/status/' + encodeURIComponent(job.tweet_id) + '?bridge=1&jobid=' + encodeURIComponent(job.id);
          } else {
            setTimeout(tick, POLL_MS); return;
          }
          console.log('[x-bridge] picking job', job.id, target);
          location.href = target;
          return;
        }
        setTimeout(tick, POLL_MS);
      });
    }, 1500);
  }
})();
`;

let lastDemandAt = Date.now() / 1000;
let lastPollAt = 0;
let wakePromise: Promise<void> | null = null;
const recent: CaptureEntry[] = [];
const jobs = new Map<string, Job>();

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function markDemand() {
  lastDemandAt = Date.now() / 1000;
}

function pushRecent(entry: CaptureEntry): void {
  recent.push(entry);
  while (recent.length > RECENT_LIMIT) recent.shift();
}

export function recentCaptures(): CaptureEntry[] {
  return recent;
}

async function cdpFetch(path: string, timeout = CDP_TIMEOUT): Promise<string> {
  const res = await fetch(CDP_BASE + path, { signal: AbortSignal.timeout(timeout * 1000) });
  if (!res.ok) throw new Error(`CDP ${path} returned ${res.status}`);
  return await res.text();
}

async function cdpJson<T = unknown>(path: string, timeout = CDP_TIMEOUT): Promise<T> {
  return JSON.parse(await cdpFetch(path, timeout)) as T;
}

async function bridgeTabs(): Promise<CDPTab[]> {
  try {
    const tabs = await cdpJson<CDPTab[]>("/json/list");
    return tabs.filter(isBridgeTab);
  } catch {
    return [];
  }
}

function isBridgeTab(tab: CDPTab): boolean {
  if (tab?.type !== "page") return false;
  try {
    const host = new URL(tab.url || "").hostname;
    return host === "x.com" || host === "twitter.com";
  } catch {
    return false;
  }
}

export async function bridgeTabOpen(): Promise<boolean> {
  return (await bridgeTabs()).length > 0;
}

export async function browserRunning(): Promise<boolean> {
  return browserPids().length > 0;
}

function cdpCommand(ws: WebSocket, id: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP command ${method} timed out`));
    }, CDP_TIMEOUT * 1000);
    const onMessage = (event: MessageEvent) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      cleanup();
      resolve(msg);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function withWebSocket<T>(url: string, fn: (ws: WebSocket) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("WebSocket open timed out"));
    }, CDP_TIMEOUT * 1000);
    ws.addEventListener("open", async () => {
      clearTimeout(timer);
      try {
        resolve(await fn(ws));
      } catch (error) {
        reject(error);
      } finally {
        try { ws.close(); } catch {}
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    });
  });
}

async function injectBridgeScript(): Promise<boolean> {
  let injected = false;
  for (const tab of await bridgeTabs()) {
    if (!tab.webSocketDebuggerUrl) continue;
    try {
      await withWebSocket(tab.webSocketDebuggerUrl, async (ws) => {
        await cdpCommand(ws, 1, "Page.enable");
        await cdpCommand(ws, 2, "Runtime.enable");
        await cdpCommand(ws, 3, "Page.addScriptToEvaluateOnNewDocument", { source: PAGE_BRIDGE_SCRIPT });
        await cdpCommand(ws, 4, "Runtime.evaluate", { expression: PAGE_BRIDGE_SCRIPT, awaitPromise: false });
      });
      injected = true;
    } catch (error) {
      log.warn("failed to inject x-bridge script into", tab.url, messageOf(error));
    }
  }
  return injected;
}

function readPowerSupplyValue(device: string, key: string): string {
  try {
    return readFileSync(`/sys/class/power_supply/${device}/${key}`, "utf8").trim();
  } catch {
    return "";
  }
}

function criticalBatteryWithoutAc(): [boolean, string] {
  if (!POWER_GUARD) return [false, "power guard disabled"];
  const acOnline = readPowerSupplyValue(POWER_AC_DEVICE, "online");
  const status = readPowerSupplyValue(POWER_BATTERY_DEVICE, "status");
  const capacityRaw = readPowerSupplyValue(POWER_BATTERY_DEVICE, "capacity");
  const present = readPowerSupplyValue(POWER_BATTERY_DEVICE, "present");
  const capacity = Number.isFinite(Number(capacityRaw)) ? Number(capacityRaw) : 100;
  const critical = acOnline === "0" && present !== "0" && status.toLowerCase() === "discharging" && capacity <= MIN_BATTERY_FOR_BROWSER;
  const detail = `${POWER_AC_DEVICE}=${acOnline || "unknown"} ${POWER_BATTERY_DEVICE}=${status || "unknown"} capacity=${capacityRaw || "unknown"}`;
  return [critical, detail];
}

function browserPids(): number[] {
  if (!BROWSER_PROFILE_DIR) return [];
  const pids = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let cmdline;
    try {
      cmdline = readFileSync(`/proc/${name}/cmdline`).toString("utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (!cmdline.includes(BROWSER_PROFILE_DIR)) continue;
    let exe = "";
    let comm = "";
    try { exe = readlinkSync(`/proc/${name}/exe`).toLowerCase(); } catch {}
    try { comm = readFileSync(`/proc/${name}/comm`, "utf8").trim().toLowerCase(); } catch {}
    if (exe.includes("chrome") || exe.includes("chromium") || comm.includes("chrome") || comm.includes("chromium")) {
      pids.push(Number(name));
    }
  }
  return pids;
}

async function hasNonBridgeTabs(): Promise<boolean> {
  let tabs: CDPTab[];
  try {
    tabs = await cdpJson<CDPTab[]>("/json/list");
  } catch {
    return false;
  }
  for (const tab of tabs) {
    if (tab?.type !== "page") continue;
    const url = tab.url || "";
    if (!url || url === "about:blank") continue;
    if (url.startsWith("chrome://") || url.startsWith("devtools://") || url.startsWith("chrome-extension://")) continue;
    if (url.includes("chrome-devtools-frontend.appspot.com")) continue;
    try {
      if (new URL(url).hostname === "www.tampermonkey.net") continue;
    } catch {}
    if (isBridgeTab(tab)) continue;
    return true;
  }
  return false;
}

function stopBrowser() {
  const pids = browserPids();
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if (!isProcessMissing(error)) log.warn("failed to terminate browser pid", pid, messageOf(error)); }
  }
  setTimeout(() => {
    for (const pid of browserPids()) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (!isProcessMissing(error)) log.warn("failed to kill browser pid", pid, messageOf(error)); }
    }
  }, 3000).unref();
}

function bridgeRecentlyPolled(): boolean {
  return lastPollAt > 0 && Date.now() / 1000 - lastPollAt <= BRIDGE_READY_SECONDS;
}

async function waitForPollAfter(startedAt: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() / 1000 + timeout;
  while (Date.now() / 1000 < deadline) {
    if (lastPollAt > startedAt || bridgeRecentlyPolled()) return true;
    await sleep(1000);
  }
  return false;
}

function runStartScript(): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (EXTRA_PATH) env.PATH = `${EXTRA_PATH}:${env.PATH || ""}`;
    const child = spawn(START_BRIDGE_SCRIPT, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`x-bridge wake timed out after ${WAKE_TIMEOUT}s`));
    }, WAKE_TIMEOUT * 1000);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`x-bridge wake failed with exit ${code}: ${tail(out)}`));
    });
  });
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).slice(-8).join("\n");
}

export async function ensureBrowserReady(reason = "bridge request"): Promise<void> {
  markDemand();
  if (bridgeRecentlyPolled()) return;
  if (wakePromise) return await wakePromise;
  wakePromise = ensureBrowserReadyInner(reason).finally(() => { wakePromise = null; });
  return await wakePromise;
}

async function ensureBrowserReadyInner(reason: string): Promise<void> {
  if (bridgeRecentlyPolled()) return;
  const [critical, powerDetail] = criticalBatteryWithoutAc();
  if (critical) throw new Error(`x-bridge browser launch blocked: critical power state (${powerDetail})`);

  if (await bridgeTabOpen()) {
    const pollStartedAt = lastPollAt;
    await injectBridgeScript();
    if (await waitForPollAfter(pollStartedAt, Math.min(POLL_READY_TIMEOUT, 30))) {
      log.info("x-bridge browser ready");
      return;
    }
  }

  if (!START_BRIDGE_SCRIPT) {
    const pollStartedAt = lastPollAt;
    await injectBridgeScript();
    if (await waitForPollAfter(pollStartedAt, POLL_READY_TIMEOUT)) {
      log.info("x-bridge browser ready");
      return;
    }
    throw new Error("x-bridge page is not polling /queries. Open https://x.com/home?bridge=1 in a logged-in browser or set XBRIDGE_START_SCRIPT.");
  }

  log.warn("x-bridge browser is not ready; starting it for", reason);
  const pollStartedAt = lastPollAt;
  const output = await runStartScript();

  for (let i = 0; i < 30; i += 1) {
    if (await bridgeTabOpen()) break;
    await sleep(2000);
  }
  if (!(await bridgeTabOpen())) throw new Error(`x-bridge tab did not become visible in CDP: ${tail(output)}`);

  await injectBridgeScript();
  if (await waitForPollAfter(pollStartedAt, POLL_READY_TIMEOUT)) {
    log.info("x-bridge browser ready");
    return;
  }
  throw new Error(`x-bridge page did not poll /queries within ${Math.trunc(POLL_READY_TIMEOUT)}s`);
}

export async function pendingCount(): Promise<number> {
  pruneStale();
  let count = 0;
  for (const job of jobs.values()) {
    if (!job.done) count += 1;
  }
  return count;
}

export async function bridgeStatus(): Promise<Record<string, unknown>> {
  const now = Date.now() / 1000;
  return {
    browser_running: await browserRunning(),
    bridge_tab_open: await bridgeTabOpen(),
    pending_jobs: await pendingCount(),
    idle_seconds: Math.trunc(now - lastDemandAt),
    idle_stop_after: IDLE_STOP_AFTER,
    bridge_last_poll_seconds: lastPollAt <= 0 ? null : Math.trunc(now - lastPollAt),
  };
}

export function startIdleReaper(): ReturnType<typeof setInterval> | null {
  if (IDLE_STOP_AFTER <= 0) {
    log.info("x-bridge idle reaper disabled");
    return null;
  }
  const timer = setInterval(async () => {
    try {
      if (await pendingCount() > 0) return;
      if (Date.now() / 1000 - lastDemandAt < IDLE_STOP_AFTER) return;
      if (!(await browserRunning())) return;
      if (await hasNonBridgeTabs()) return;
      log.info(`x-bridge idle for ${Math.trunc(Date.now() / 1000 - lastDemandAt)}s; stopping bridge browser`);
      stopBrowser();
    } catch (error) {
      log.error("x-bridge idle reaper error", error);
    }
  }, IDLE_CHECK_INTERVAL * 1000);
  return timer;
}

function createJob(fields: JobFields): Job {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return {
    id: `j_${secrets(6)}`,
    createdAt: Date.now() / 1000,
    done: false,
    result: null,
    raw: null,
    promise,
    resolve,
    ...fields,
  };
}

function secrets(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function enqueueSearch(q: string, type: SearchType): Job {
  markDemand();
  const job = createJob({ kind: "search", q, type, tweet_id: "" });
  jobs.set(job.id, job);
  log.info("enqueued search job", job.id, JSON.stringify(q), "type=" + type);
  return job;
}

export function enqueueTweet(tweetId: string): Job {
  markDemand();
  const job = createJob({ kind: "tweet", q: "", type: "Top", tweet_id: tweetId });
  jobs.set(job.id, job);
  log.info("enqueued tweet job", job.id, "id=" + tweetId);
  return job;
}

export function pendingQueue(): Record<string, string>[] {
  lastPollAt = Date.now() / 1000;
  pruneStale();
  return [...jobs.values()].filter((j) => !j.done).map((j) => ({
    id: j.id,
    kind: j.kind,
    q: j.q,
    type: j.type,
    tweet_id: j.tweet_id,
  }));
}

function pruneStale() {
  const now = Date.now() / 1000;
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > STALE_AFTER) jobs.delete(id);
  }
}

export function abort(jobid: string): Record<string, unknown> {
  const job = jobs.get(jobid);
  if (job && !job.done) {
    log.info(`bridge watchdog reported for job ${jobid}; keeping pending for ${ABORT_GRACE_SECONDS}s late-capture grace`);
    setTimeout(() => completeAfterAbortGrace(jobid), ABORT_GRACE_SECONDS * 1000).unref();
    return { ok: true, aborted: false, keptPending: true, graceSeconds: ABORT_GRACE_SECONDS };
  }
  return { ok: true, aborted: false, keptPending: false };
}

function completeAfterAbortGrace(jobid: string): void {
  const job = jobs.get(jobid);
  if (job && !job.done) {
    job.result = [];
    job.done = true;
    job.resolve();
    log.warn("job", jobid, "completed empty after bridge watchdog grace");
  }
}

export function deliverCapture(op: string, url: string, body: string, jobid: string | null): Record<string, unknown> {
  let data: unknown;
  try {
    data = body ? JSON.parse(body) : {};
  } catch (error) {
    pushRecent({ op, url, jobid, preview: (body || "").slice(0, 400), error: error.message });
    return { ok: false, error: "invalid_json" };
  }
  pushRecent({ op, url, jobid, body_len: (body || "").length, body: body || "" });

  if (jobid && jobs.has(jobid)) {
    const job = jobs.get(jobid);
    job.raw = data;
    try {
      job.result = job.kind === "search" ? parseSearch(data) : parseTweetDetail(data);
    } catch (error) {
      log.error("parse error jobid=" + jobid, "op=" + op, error);
      job.result = [];
    }
    job.done = true;
    job.resolve();
    log.info("capture matched job", jobid, "op=" + op, "items=" + (job.result || []).length);
    return { ok: true, matched: true, items: (job.result || []).length };
  }

  return { ok: true, matched: false };
}

export async function waitFor(job: Job, timeout = 60): Promise<Tweet[]> {
  try {
    await Promise.race([
      job.promise,
      sleep(timeout * 1000).then(() => { throw new Error("timeout"); }),
    ]);
    return job.result || [];
  } catch (error) {
    if (error.message !== "timeout") throw error;
    log.warn("job", job.id, "timed out");
    return [];
  } finally {
    jobs.delete(job.id);
  }
}

function tweetFromResult(input: unknown): Tweet | null {
  let tr = asRecord(input);
  if (!Object.keys(tr).length) return null;
  if (asString(tr.__typename) === "TweetWithVisibilityResults") tr = asRecord(tr.tweet);
  const legacy = asRecord(tr.legacy);
  if (!Object.keys(legacy).length) return null;
  const userResult = asRecord(asRecord(asRecord(tr.core).user_results).result);
  const userLegacy = asRecord(userResult.legacy);
  const userCore = asRecord(userResult.core);
  const screenName = asString(userLegacy.screen_name) || asString(userCore.screen_name);
  const name = asString(userLegacy.name) || asString(userCore.name);
  const userId = asString(userResult.rest_id) || asString(legacy.user_id_str);
  const id = asString(tr.rest_id) || asString(legacy.id_str);
  const text = asString(legacy.full_text) || asString(legacy.text);
  const views = asRecord(tr.views).count ?? asRecord(legacy.ext_views).count;
  const viewCount = numberOrNull(views);
  const conversationId = asString(legacy.conversation_id_str) || id;

  return {
    id,
    text,
    created_at: asString(legacy.created_at) || undefined,
    user: { id: userId, name, screen_name: screenName },
    favorite_count: numberOrZero(legacy.favorite_count),
    retweet_count: numberOrZero(legacy.retweet_count),
    reply_count: numberOrZero(legacy.reply_count),
    quote_count: numberOrZero(legacy.quote_count),
    view_count: viewCount,
    lang: asString(legacy.lang) || undefined,
    is_reply: Boolean(asString(legacy.in_reply_to_status_id_str)),
    conversation_id: conversationId,
    url: screenName && id ? `https://x.com/${screenName}/status/${id}` : null,
  };
}

export function parseSearch(data: unknown): Tweet[] {
  const out: Tweet[] = [];
  const root = asRecord(data);
  const instructions = asArray(
    asRecord(
      asRecord(
        asRecord(
          asRecord(root.data).search_by_raw_query,
        ).search_timeline,
      ).timeline,
    ).instructions,
  );
  for (const instructionValue of instructions) {
    const instruction = asRecord(instructionValue);
    for (const entryValue of asArray(instruction.entries)) {
      const entry = asRecord(entryValue);
      const itemContent = asRecord(asRecord(entry.content).itemContent);
      if (asString(itemContent.itemType) !== "TimelineTweet") continue;
      const tweet = tweetFromResult(asRecord(itemContent.tweet_results).result);
      if (tweet) out.push(tweet);
    }
  }
  return out;
}

export function parseTweetDetail(data: unknown): Tweet[] {
  const root = asRecord(data);
  const instructions = asArray(asRecord(asRecord(root.data).threaded_conversation_with_injections_v2).instructions);
  const tweets: Tweet[] = [];
  const seen = new Set<string>();
  for (const instructionValue of instructions) {
    const instruction = asRecord(instructionValue);
    if (asString(instruction.type) !== "TimelineAddEntries") continue;
    for (const entryValue of asArray(instruction.entries)) {
      const entry = asRecord(entryValue);
      const content = asRecord(entry.content);
      const itemContent = asRecord(content.itemContent);
      const entryType = asString(content.entryType) || asString(itemContent.itemType);
      if (entryType === "TimelineTimelineItem") {
        const tweet = tweetFromResult(asRecord(itemContent.tweet_results).result);
        if (tweet && !seen.has(tweet.id)) {
          tweets.push(tweet);
          seen.add(tweet.id);
        }
      } else if (entryType === "TimelineTimelineModule") {
        for (const itemValue of asArray(content.items)) {
          const item = asRecord(itemValue);
          const moduleItemContent = asRecord(asRecord(item.item).itemContent);
          const tweet = tweetFromResult(asRecord(moduleItemContent.tweet_results).result);
          if (tweet && !seen.has(tweet.id)) {
            tweets.push(tweet);
            seen.add(tweet.id);
          }
        }
      }
    }
  }
  return tweets;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProcessMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ESRCH";
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
