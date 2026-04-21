"""
Bridge: job queue + X GraphQL response parsing.

Real browser runs a userscript that intercepts x.com GraphQL responses and
POSTs them here. Agents submit search/reply jobs; bridge tab picks them up,
navigates, and pushes the captured JSON back. The library-side TID generation
that broke in twikit/twscrape/tweety is replaced by "let the real browser do it."
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger("auto-tweet.bridge")


@dataclass
class Job:
    id: str
    kind: str                       # "search" | "tweet"
    q: str = ""                     # search query (kind=search)
    type: str = "Top"               # "Top" | "Latest" (kind=search)
    tweet_id: str = ""              # tweet id (kind=tweet)
    created_at: float = field(default_factory=time.time)
    event: asyncio.Event = field(default_factory=asyncio.Event)
    result: Optional[list[dict]] = None     # parsed output
    raw: Optional[dict] = None              # last captured payload (for debug)

    def to_queue_entry(self) -> dict:
        return {"id": self.id, "kind": self.kind, "q": self.q, "type": self.type, "tweet_id": self.tweet_id}


_jobs: dict[str, Job] = {}
_lock = asyncio.Lock()
STALE_AFTER = 300  # seconds


async def enqueue_search(q: str, type: str) -> Job:
    j = Job(id="j_" + secrets.token_hex(6), kind="search", q=q, type=type)
    async with _lock:
        _jobs[j.id] = j
    log.info("enqueued search job %s q=%r type=%s", j.id, q, type)
    return j


async def enqueue_tweet(tweet_id: str) -> Job:
    j = Job(id="j_" + secrets.token_hex(6), kind="tweet", tweet_id=tweet_id)
    async with _lock:
        _jobs[j.id] = j
    log.info("enqueued tweet job %s id=%s", j.id, tweet_id)
    return j


async def pending_queue() -> list[dict]:
    """Return pending jobs for the userscript poller."""
    async with _lock:
        _prune_stale()
        return [j.to_queue_entry() for j in _jobs.values() if not j.event.is_set()]


def _prune_stale() -> None:
    now = time.time()
    drop = [jid for jid, j in _jobs.items() if now - j.created_at > STALE_AFTER]
    for jid in drop:
        _jobs.pop(jid, None)


async def abort(jobid: str) -> dict:
    """Cancel a pending job. Userscript calls this on watchdog expiry."""
    async with _lock:
        j = _jobs.pop(jobid, None)
    if j and not j.event.is_set():
        j.result = []
        j.event.set()
        log.info("aborted job %s", jobid)
        return {"ok": True, "aborted": True}
    return {"ok": True, "aborted": False}


async def deliver_capture(op: str, url: str, body: str, jobid: Optional[str]) -> dict:
    """Userscript POSTs a captured payload. Parse + wake the waiter."""
    try:
        data = json.loads(body) if body else {}
    except Exception as e:
        log.warning("capture parse error for jobid=%s op=%s: %s", jobid, op, e)
        return {"ok": False, "error": "invalid_json"}

    if jobid and jobid in _jobs:
        j = _jobs[jobid]
        j.raw = data
        try:
            if j.kind == "search":
                j.result = parse_search(data)
            elif j.kind == "tweet":
                j.result = parse_tweet_detail(data)
        except Exception as e:
            log.exception("parse error jobid=%s op=%s: %s", jobid, op, e)
            j.result = []
        j.event.set()
        log.info("capture matched job %s op=%s items=%d", jobid, op, len(j.result or []))
        return {"ok": True, "matched": True, "items": len(j.result or [])}

    log.debug("capture with no matching job jobid=%s op=%s", jobid, op)
    return {"ok": True, "matched": False}


async def wait_for(job: Job, timeout: float = 60.0) -> list[dict]:
    try:
        await asyncio.wait_for(job.event.wait(), timeout=timeout)
        return job.result or []
    except asyncio.TimeoutError:
        log.warning("job %s timed out", job.id)
        return []
    finally:
        async with _lock:
            _jobs.pop(job.id, None)


# --------- parsers ---------

def _tweet_from_result(tr: dict) -> Optional[dict]:
    """Extract a normalized tweet dict from a tweet_results.result node."""
    if not isinstance(tr, dict):
        return None
    if tr.get("__typename") == "TweetWithVisibilityResults":
        tr = tr.get("tweet", tr)

    legacy = tr.get("legacy") or {}
    if not legacy:
        return None
    core = tr.get("core") or {}
    user_res = core.get("user_results", {}).get("result", {})
    ul = user_res.get("legacy") or {}
    screen_name = ul.get("screen_name") or user_res.get("core", {}).get("screen_name") or ""
    name = ul.get("name") or user_res.get("core", {}).get("name") or ""
    user_id = user_res.get("rest_id") or legacy.get("user_id_str") or ""

    tid = tr.get("rest_id") or legacy.get("id_str") or ""
    text = legacy.get("full_text") or legacy.get("text") or ""
    views = ((tr.get("views") or {}).get("count")) or legacy.get("ext_views", {}).get("count")
    try:
        view_count = int(views) if views is not None else None
    except Exception:
        view_count = None

    is_reply = bool(legacy.get("in_reply_to_status_id_str"))
    conv_id = legacy.get("conversation_id_str") or tid

    return {
        "id": tid,
        "text": text,
        "created_at": legacy.get("created_at"),
        "user": {
            "id": user_id,
            "name": name,
            "screen_name": screen_name,
        },
        "favorite_count": legacy.get("favorite_count", 0),
        "retweet_count": legacy.get("retweet_count", 0),
        "reply_count": legacy.get("reply_count", 0),
        "quote_count": legacy.get("quote_count", 0),
        "view_count": view_count,
        "lang": legacy.get("lang"),
        "is_reply": is_reply,
        "conversation_id": conv_id,
        "url": f"https://x.com/{screen_name}/status/{tid}" if screen_name and tid else None,
    }


def parse_search(data: dict) -> list[dict]:
    out: list[dict] = []
    insts = (
        ((data.get("data") or {})
         .get("search_by_raw_query") or {})
        .get("search_timeline", {})
        .get("timeline", {})
        .get("instructions", [])
    )
    for ins in insts:
        for e in ins.get("entries", []) or []:
            ic = (e.get("content") or {}).get("itemContent") or {}
            if ic.get("itemType") != "TimelineTweet":
                continue
            tr = ic.get("tweet_results", {}).get("result")
            t = _tweet_from_result(tr) if tr else None
            if t:
                out.append(t)
    return out


def parse_tweet_detail(data: dict) -> list[dict]:
    """Returns [main_tweet, reply1, reply2, ...]. Main tweet first."""
    insts = (
        ((data.get("data") or {})
         .get("threaded_conversation_with_injections_v2") or {})
        .get("instructions", [])
    )
    tweets: list[dict] = []
    seen: set[str] = set()
    for ins in insts:
        if ins.get("type") != "TimelineAddEntries":
            continue
        for e in ins.get("entries", []) or []:
            content = e.get("content") or {}
            etype = content.get("entryType") or content.get("itemContent", {}).get("itemType")
            if etype == "TimelineTimelineItem":
                ic = content.get("itemContent") or {}
                tr = ic.get("tweet_results", {}).get("result")
                t = _tweet_from_result(tr) if tr else None
                if t and t["id"] not in seen:
                    tweets.append(t); seen.add(t["id"])
            elif etype == "TimelineTimelineModule":
                for item in content.get("items", []) or []:
                    ic = (item.get("item") or {}).get("itemContent") or {}
                    tr = ic.get("tweet_results", {}).get("result")
                    t = _tweet_from_result(tr) if tr else None
                    if t and t["id"] not in seen:
                        tweets.append(t); seen.add(t["id"])
    return tweets
