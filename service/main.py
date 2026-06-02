"""
x-bridge reference service.

Minimal FastAPI server that pairs with the x-bridge userscript. Submit search /
tweet-detail jobs over HTTP; the userscript drives your real Chrome tab to
fetch them; this service collects the response and returns normalized tweets.

Run:
    pip install -r requirements.txt
    python main.py

Then open a Chrome window to https://x.com/home?bridge=1 with the userscript
installed. Submit a query: curl 'http://127.0.0.1:19816/search?q=AI+agents'.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import FastAPI, Query
from pydantic import BaseModel
import uvicorn

import bridge

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s %(message)s")
XBRIDGE_JOB_TIMEOUT = float(os.environ.get("XBRIDGE_JOB_TIMEOUT", "120"))

app = FastAPI(title="x-bridge reference service")


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
    """Polled by the userscript. Returns pending jobs."""
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
    """POSTed by the userscript with a captured GraphQL response."""
    return await bridge.deliver_capture(req.op, req.url, req.body, req.jobid)


class AbortBody(BaseModel):
    jobid: str


@app.post("/abort")
async def abort(req: AbortBody):
    """POSTed by the userscript when the watchdog expires."""
    return await bridge.abort(req.jobid)


@app.get("/debug/recent")
async def debug_recent():
    return {"recent": bridge.recent_captures()}


@app.get("/debug/bridge")
async def debug_bridge():
    return await bridge.bridge_status()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=19816)
