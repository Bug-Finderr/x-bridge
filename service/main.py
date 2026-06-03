"""
x-bridge reference service.

Minimal FastAPI server that pairs with a CDP-injected x-bridge script. Submit
search/tweet-detail jobs over HTTP; the bridge script drives your real Chrome
tab to fetch them; this service collects the response and returns normalized
tweets.

Run:
    pip install -r requirements.txt
    python main.py

Then open a Chrome window to https://x.com/home?bridge=1 with CDP enabled. Submit a query: curl 'http://127.0.0.1:19816/search?q=AI+agents'.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Query, Request, Response
from pydantic import BaseModel
import uvicorn

import bridge

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s %(message)s")
XBRIDGE_HOST = os.environ.get("XBRIDGE_HOST", "127.0.0.1")
XBRIDGE_PORT = int(os.environ.get("XBRIDGE_PORT", "19816"))
XBRIDGE_JOB_TIMEOUT = float(os.environ.get("XBRIDGE_JOB_TIMEOUT", "120"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    idle_task = asyncio.create_task(bridge.idle_reaper())
    try:
        yield
    finally:
        idle_task.cancel()
        try:
            await idle_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="x-bridge reference service", lifespan=lifespan)


@app.middleware("http")
async def cors_for_x_bridge(request: Request, call_next):
    if request.method == "OPTIONS":
        response = Response()
    else:
        response = await call_next(request)
    origin = request.headers.get("origin")
    if origin in {"https://x.com", "https://twitter.com"}:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/search")
async def search(
    q: str = Query(..., description="Search query"),
    type: str = Query("Top", description="Top or Latest"),
    count: int = Query(20, ge=1, le=50),
):
    """Enqueue a search. Blocks until the bridge tab captures a response or timeout."""
    if type not in ("Top", "Latest"):
        return {"error": "type must be Top or Latest"}
    await bridge.ensure_browser_ready("search")
    job = await bridge.enqueue_search(q, type)
    tweets = await bridge.wait_for(job, timeout=XBRIDGE_JOB_TIMEOUT)
    return tweets[:count]


@app.get("/replies/{tweet_id}")
async def replies(tweet_id: str, count: int = Query(40, ge=1, le=100)):
    """Fetch a tweet plus its reply thread. Returns [main, reply1, reply2, ...]."""
    await bridge.ensure_browser_ready("replies")
    job = await bridge.enqueue_tweet(tweet_id)
    out = await bridge.wait_for(job, timeout=XBRIDGE_JOB_TIMEOUT)
    return out[: count + 1]


@app.get("/queries")
async def queue():
    """Polled by the bridge script. Returns pending jobs."""
    q = await bridge.pending_queue()
    return {"queue": q}


class CaptureBody(BaseModel):
    op: str
    url: str
    body: str
    jobid: Optional[str] = None
    captured_at: Optional[str] = None


@app.post("/captured")
async def captured(req: CaptureBody):
    """POSTed by the bridge script with a captured GraphQL response."""
    return await bridge.deliver_capture(req.op, req.url, req.body, req.jobid)


class AbortBody(BaseModel):
    jobid: str


@app.post("/abort")
async def abort(req: AbortBody):
    """POSTed by the bridge script when the watchdog expires."""
    return await bridge.abort(req.jobid)


@app.get("/debug/recent")
async def debug_recent():
    return {"recent": bridge.recent_captures()}


@app.get("/debug/bridge")
async def debug_bridge():
    return await bridge.bridge_status()


if __name__ == "__main__":
    uvicorn.run(app, host=XBRIDGE_HOST, port=XBRIDGE_PORT)
