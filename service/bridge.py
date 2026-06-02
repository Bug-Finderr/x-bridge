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
import os
import signal
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.request import urlopen

log = logging.getLogger("xbridge.bridge")

# Debug: keep last N raw captures for inspection
from collections import deque
_last_captures = deque(maxlen=20)

CDP_BASE = os.environ.get("XBRIDGE_CDP_BASE", "http://127.0.0.1:18800").rstrip("/")
START_BRIDGE_SCRIPT = Path(os.environ.get("XBRIDGE_START_SCRIPT", "/home/bug/start-bridge-tab.sh"))
OPENCLAW_PROFILE_DIR = Path(os.environ.get(
    "OPENCLAW_PROFILE_DIR",
    str(Path.home() / ".openclaw/browser/openclaw/user-data"),
))
IDLE_STOP_AFTER = int(os.environ.get("XBRIDGE_IDLE_SECONDS", "600"))
IDLE_CHECK_INTERVAL = int(os.environ.get("XBRIDGE_IDLE_CHECK_SECONDS", "60"))
WAKE_TIMEOUT = int(os.environ.get("XBRIDGE_WAKE_TIMEOUT", "240"))
CDP_TIMEOUT = float(os.environ.get("XBRIDGE_CDP_TIMEOUT", "8"))
MIN_BATTERY_FOR_BROWSER = int(os.environ.get("XBRIDGE_MIN_BATTERY_FOR_BROWSER", "5"))
POLL_READY_TIMEOUT = float(os.environ.get("XBRIDGE_POLL_READY_TIMEOUT", "150"))
ABORT_GRACE_SECONDS = float(os.environ.get("XBRIDGE_ABORT_GRACE_SECONDS", "20"))

_last_demand_at = time.time()
_last_poll_at = 0.0
_wake_lock = asyncio.Lock()


def recent_captures() -> list[dict]:
    return list(_last_captures)


def _openclaw_env() -> dict[str, str]:
    env = os.environ.copy()
    node_bin = str(Path.home() / ".local/share/fnm/node-versions/v25.9.0/installation/bin")
    env["PATH"] = f"{node_bin}:{env.get('PATH', '')}"
    return env


def _profile_pgrep_pattern() -> str:
    profile = str(OPENCLAW_PROFILE_DIR)
    return "[/]" + profile[1:] if profile.startswith("/") else profile


def _mark_demand() -> None:
    global _last_demand_at
    _last_demand_at = time.time()


def _cdp_fetch(path: str, timeout: float = CDP_TIMEOUT) -> str:
    with urlopen(f"{CDP_BASE}{path}", timeout=timeout) as resp:
        return resp.read(2_000_000).decode("utf-8", "replace")


def _cdp_ready_sync() -> bool:
    try:
        _cdp_fetch("/json/version")
        return True
    except Exception:
        return False


def _bridge_tab_open_sync() -> bool:
    try:
        tabs = _cdp_fetch("/json/list")
        return "https://x.com/" in tabs or "https://twitter.com/" in tabs
    except Exception:
        return False


def _browser_running_sync() -> bool:
    return bool(_browser_pids_sync())


def _read_power_supply_value(device: str, key: str) -> str:
    try:
        return Path(f"/sys/class/power_supply/{device}/{key}").read_text("utf-8", "replace").strip()
    except Exception:
        return ""


def _critical_battery_without_ac_sync() -> tuple[bool, str]:
    ac_online = _read_power_supply_value("ACAD", "online")
    status = _read_power_supply_value("BAT1", "status")
    capacity_raw = _read_power_supply_value("BAT1", "capacity")
    present = _read_power_supply_value("BAT1", "present")
    try:
        capacity = int(capacity_raw)
    except ValueError:
        capacity = 100

    critical = (
        ac_online == "0"
        and present != "0"
        and status.lower() == "discharging"
        and capacity <= MIN_BATTERY_FOR_BROWSER
    )
    detail = f"ACAD={ac_online or 'unknown'} BAT1={status or 'unknown'} capacity={capacity_raw or 'unknown'}"
    return critical, detail


def _browser_pids_sync() -> list[int]:
    profile = str(OPENCLAW_PROFILE_DIR)
    pids: list[int] = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            raw_cmdline = (proc / "cmdline").read_bytes()
            cmdline = raw_cmdline.replace(b"\0", b" ").decode("utf-8", "replace")
        except Exception:
            continue
        if profile not in cmdline:
            continue
        try:
            exe_name = Path(os.readlink(proc / "exe")).name.lower()
        except Exception:
            exe_name = ""
        try:
            comm = (proc / "comm").read_text("utf-8", "replace").strip().lower()
        except Exception:
            comm = ""
        if "chrome" in exe_name or "chromium" in exe_name or "chrome" in comm or "chromium" in comm:
            pids.append(int(proc.name))
    return pids


def _has_non_bridge_tabs_sync() -> bool:
    try:
        tabs = json.loads(_cdp_fetch("/json/list"))
    except Exception:
        return False
    for tab in tabs:
        url = tab.get("url") or ""
        if not url or url == "about:blank":
            continue
        if url.startswith(("chrome://", "devtools://", "chrome-extension://")):
            continue
        if "chrome-devtools-frontend.appspot.com" in url:
            continue
        if "://x.com/" in url or "://twitter.com/" in url:
            continue
        return True
    return False


def _stop_browser_sync() -> None:
    pids = _browser_pids_sync()
    if not pids:
        return

    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception as exc:
            log.warning("failed to terminate browser pid %s: %s", pid, exc)
    time.sleep(3)
    for pid in _browser_pids_sync():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception as exc:
            log.warning("failed to kill browser pid %s: %s", pid, exc)


async def bridge_tab_open() -> bool:
    return await asyncio.to_thread(_bridge_tab_open_sync)


async def browser_running() -> bool:
    return await asyncio.to_thread(_browser_running_sync)


async def ensure_browser_ready(reason: str = "bridge request") -> None:
    """Start or repair the dedicated OpenClaw browser before queuing a bridge job."""
    _mark_demand()
    if await bridge_tab_open():
        return

    async with _wake_lock:
        if await bridge_tab_open():
            return

        critical_power, power_detail = await asyncio.to_thread(_critical_battery_without_ac_sync)
        if critical_power:
            raise RuntimeError(f"x-bridge browser launch blocked: critical power state ({power_detail})")

        log.warning("x-bridge browser is not ready; starting it for %s", reason)
        poll_started_at = _last_poll_at
        proc = await asyncio.create_subprocess_exec(
            str(START_BRIDGE_SCRIPT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=_openclaw_env(),
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=WAKE_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"x-bridge wake timed out after {WAKE_TIMEOUT}s")

        output = stdout.decode("utf-8", "replace") if stdout else ""
        if proc.returncode != 0:
            tail = "\n".join(output.strip().splitlines()[-8:])
            raise RuntimeError(f"x-bridge wake failed with exit {proc.returncode}: {tail}")

        for _ in range(30):
            if await bridge_tab_open():
                break
            await asyncio.sleep(2)
        else:
            tail = "\n".join(output.strip().splitlines()[-8:])
            raise RuntimeError(f"x-bridge tab did not become visible in CDP: {tail}")

        deadline = time.time() + POLL_READY_TIMEOUT
        while time.time() < deadline:
            if _last_poll_at > poll_started_at:
                log.info("x-bridge browser ready")
                return
            await asyncio.sleep(1)

        raise RuntimeError(f"x-bridge userscript did not poll /queries within {int(POLL_READY_TIMEOUT)}s")


async def pending_count() -> int:
    async with _lock:
        _prune_stale()
        return sum(1 for j in _jobs.values() if not j.event.is_set())


async def bridge_status() -> dict:
    now = time.time()
    return {
        "browser_running": await browser_running(),
        "bridge_tab_open": await bridge_tab_open(),
        "pending_jobs": await pending_count(),
        "idle_seconds": int(now - _last_demand_at),
        "idle_stop_after": IDLE_STOP_AFTER,
        "userscript_last_poll_seconds": None if _last_poll_at <= 0 else int(now - _last_poll_at),
    }


async def idle_reaper() -> None:
    """Stop the headed browser after bridge demand goes quiet."""
    if IDLE_STOP_AFTER <= 0:
        log.info("x-bridge idle reaper disabled")
        return

    while True:
        await asyncio.sleep(IDLE_CHECK_INTERVAL)
        try:
            if await pending_count() > 0:
                continue
            if time.time() - _last_demand_at < IDLE_STOP_AFTER:
                continue
            if not await browser_running():
                continue

            has_other_tabs = await asyncio.to_thread(_has_non_bridge_tabs_sync)
            if has_other_tabs:
                continue

            log.info("x-bridge idle for %ss; stopping OpenClaw browser", int(time.time() - _last_demand_at))
            await asyncio.to_thread(_stop_browser_sync)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("x-bridge idle reaper error")


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
    _mark_demand()
    j = Job(id="j_" + secrets.token_hex(6), kind="search", q=q, type=type)
    async with _lock:
        _jobs[j.id] = j
    log.info("enqueued search job %s q=%r type=%s", j.id, q, type)
    return j


async def enqueue_tweet(tweet_id: str) -> Job:
    _mark_demand()
    j = Job(id="j_" + secrets.token_hex(6), kind="tweet", tweet_id=tweet_id)
    async with _lock:
        _jobs[j.id] = j
    log.info("enqueued tweet job %s id=%s", j.id, tweet_id)
    return j


async def pending_queue() -> list[dict]:
    """Return pending jobs for the userscript poller."""
    global _last_poll_at
    _last_poll_at = time.time()
    async with _lock:
        _prune_stale()
        return [j.to_queue_entry() for j in _jobs.values() if not j.event.is_set()]


def _prune_stale() -> None:
    now = time.time()
    drop = [jid for jid, j in _jobs.items() if now - j.created_at > STALE_AFTER]
    for jid in drop:
        _jobs.pop(jid, None)


async def abort(jobid: str) -> dict:
    """Record a userscript watchdog and bound the late-capture wait.

    X can deliver the GraphQL response after the userscript watchdog redirects
    back home. Keep the job pending briefly for that late capture, then complete
    empty so one bad X query cannot consume the full HTTP timeout.
    """
    async with _lock:
        j = _jobs.get(jobid)
    if j and not j.event.is_set():
        log.info(
            "userscript watchdog reported for job %s; keeping pending for %.0fs late-capture grace",
            jobid,
            ABORT_GRACE_SECONDS,
        )
        asyncio.create_task(_complete_after_abort_grace(jobid))
        return {"ok": True, "aborted": False, "keptPending": True, "graceSeconds": ABORT_GRACE_SECONDS}
    return {"ok": True, "aborted": False, "keptPending": False}


async def _complete_after_abort_grace(jobid: str) -> None:
    await asyncio.sleep(ABORT_GRACE_SECONDS)
    async with _lock:
        j = _jobs.get(jobid)
    if j and not j.event.is_set():
        j.result = []
        j.event.set()
        log.warning("job %s completed empty after userscript watchdog grace", jobid)


async def deliver_capture(op: str, url: str, body: str, jobid: Optional[str]) -> dict:
    """Userscript POSTs a captured payload. Parse + wake the waiter."""
    try:
        data = json.loads(body) if body else {}
    except Exception as e:
        _last_captures.append({"op": op, "url": url, "jobid": jobid, "preview": (body or "")[:400], "error": str(e)})
        return {"ok": False, "error": "invalid_json"}
    _last_captures.append({"op": op, "url": url, "jobid": jobid, "body_len": len(body or "")})
    _placeholder_noop = None
    if False:
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
