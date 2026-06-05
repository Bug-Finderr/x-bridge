import http from "node:http";
import {
  abort,
  bridgeStatus,
  deliverCapture,
  enqueueSearch,
  enqueueTweet,
  ensureBrowserReady,
  pendingQueue,
  recentCaptures,
  startIdleReaper,
  waitFor,
} from "./bridge.ts";

const HOST = process.env.XBRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.XBRIDGE_PORT || 19816);
const JOB_TIMEOUT = Number(process.env.XBRIDGE_JOB_TIMEOUT || 300);
const BODY_LIMIT = Number(process.env.XBRIDGE_BODY_LIMIT || 50 * 1024 * 1024);
type SearchType = "Top" | "Latest";

const idleTimer = startIdleReaper();

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(new Date().toISOString(), "[ERROR]", error);
    sendJson(req, res, 500, { error: messageOf(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.info(new Date().toISOString(), "[INFO]", `x-bridge listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (idleTimer) clearInterval(idleTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "OPTIONS") {
    sendEmpty(req, res, 204);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(req, res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/search") {
    const q = url.searchParams.get("q");
    const type = url.searchParams.get("type") || "Top";
    const count = clamp(Number(url.searchParams.get("count") || 20), 1, 50);
    if (!q) {
      sendJson(req, res, 400, { error: "q is required" });
      return;
    }
    if (!isSearchType(type)) {
      sendJson(req, res, 200, { error: "type must be Top or Latest" });
      return;
    }
    await ensureBrowserReady("search");
    const job = enqueueSearch(q, type);
    const tweets = await waitFor(job, JOB_TIMEOUT);
    sendJson(req, res, 200, tweets.slice(0, count));
    return;
  }

  const repliesMatch = url.pathname.match(/^\/replies\/([^/]+)$/);
  if (req.method === "GET" && repliesMatch) {
    const tweetId = decodeURIComponent(repliesMatch[1]);
    const count = clamp(Number(url.searchParams.get("count") || 40), 1, 100);
    await ensureBrowserReady("replies");
    const job = enqueueTweet(tweetId);
    const tweets = await waitFor(job, JOB_TIMEOUT);
    sendJson(req, res, 200, tweets.slice(0, count + 1));
    return;
  }

  if (req.method === "GET" && url.pathname === "/queries") {
    sendJson(req, res, 200, { queue: pendingQueue() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/captured") {
    const body = await readJson(req);
    sendJson(req, res, 200, deliverCapture(asString(body.op), asString(body.url), asString(body.body), asString(body.jobid) || null));
    return;
  }

  if (req.method === "POST" && url.pathname === "/abort") {
    const body = await readJson(req);
    sendJson(req, res, 200, abort(asString(body.jobid)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/debug/recent") {
    sendJson(req, res, 200, { recent: recentCaptures() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/debug/bridge") {
    sendJson(req, res, 200, await bridgeStatus());
    return;
  }

  sendJson(req, res, 404, { error: "not_found" });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isSearchType(value: string): value is SearchType {
  return value === "Top" || value === "Latest";
}

function sendEmpty(req: http.IncomingMessage, res: http.ServerResponse, status: number): void {
  setCors(req, res);
  res.writeHead(status);
  res.end();
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown): void {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin === "https://x.com" || origin === "https://twitter.com") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = text ? JSON.parse(text) : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
