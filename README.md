# x-bridge

Browser-assisted access to the `x.com` GraphQL API for scripts, agents, and automation. Works when every unofficial Twitter/X scraper library doesn't.

## Why this exists

Unofficial X scraper libraries — [twikit](https://github.com/d60/twikit), [twscrape](https://github.com/vladkens/twscrape), [tweety-ns](https://github.com/mahrtayyab/tweety), and friends — all depend on generating the `x-client-transaction-id` header by parsing an obfuscated `ondemand.s.*.js` file shipped by X. Around March 2026 X changed how that file is named and served, and every downstream library broke at once:

- [iSarabjitDhiman/XClientTransaction#35](https://github.com/iSarabjitDhiman/XClientTransaction/issues/35)
- [d60/twikit#417](https://github.com/d60/twikit/issues/417)
- [vladkens/twscrape](https://github.com/vladkens/twscrape) (last release Apr 2025, still failing)

No public fix exists as of April 2026. Every library in this space is chasing the same moving target.

**Inside a real logged-in Chrome tab, X's own JavaScript generates valid transaction IDs on its own.** x-bridge stops fighting the reimplementation problem. The browser is the scraper; this service is just a queue and a parser.

## Architecture

```
  your agent / cron / script
         │  (HTTP to localhost)
         ▼
  ┌──────────────────┐          ┌─────────────────────┐
  │ bridge service   │◀────────▶│ x-bridge userscript │
  │ FastAPI, :19816  │  jobs +  │ Chrome, logged in   │
  │ (Python)         │  captures│ to x.com            │
  └──────────────────┘          └─────────────────────┘
                                          │
                                  navigates + lets X's own
                                  JS fire the GraphQL call
                                          ▼
                                      x.com
```

1. Your agent submits `GET /search?q=...` to the service.
2. Service enqueues a job. The userscript (running in your dedicated "bridge tab") polls `/queries` every ~5s, sees the job.
3. Userscript navigates the bridge tab to `x.com/search?q=...&bridge=1&jobid=...`.
4. X renders the page normally. The userscript's `fetch`/`XHR` interceptor grabs the raw `SearchTimeline` response.
5. Userscript POSTs the raw JSON to `/captured`. Service parses, wakes the waiting request. Normalized tweets come back.

Works today for `SearchTimeline`, `UserTweets`, `UserTweetsAndReplies`, `HomeTimeline`, `HomeLatestTimeline`, and `TweetDetail` (tweet + replies). Add more by editing `CAPTURE_OPS` in the userscript.

### CSP note

X serves a nonce-based `script-src` CSP, so injecting inline `<script>` into the page is blocked. The userscript patches `window.fetch` / `XMLHttpRequest` via Tampermonkey's `unsafeWindow` handle — extension privileges bypass the CSP cleanly. This means the userscript requires `@grant unsafeWindow` in the header, which Tampermonkey will prompt you to approve on install.

## Install

### Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Tampermonkey Dashboard → **Utilities** → "Import from URL":
   ```
   https://raw.githubusercontent.com/Bug-Finderr/x-bridge/main/x-bridge.user.js
   ```
   Click Install. Approve the `unsafeWindow` + `@connect 127.0.0.1` permissions when prompted.
3. Open `https://x.com/home?bridge=1` in its own dedicated Chrome window. Keep it open. Minimizing is fine.

Updates land automatically via `@updateURL`.

### Reference service

```bash
git clone https://github.com/Bug-Finderr/x-bridge
cd x-bridge/service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Server listens on `127.0.0.1:19816`. Swagger docs at `http://127.0.0.1:19816/docs`.

## Usage

Any HTTP client works — no library needed.

```bash
# Top tab search
curl 'http://127.0.0.1:19816/search?q=AI+agents&type=Top&count=10'

# Latest tab search
curl 'http://127.0.0.1:19816/search?q=founding+engineer&type=Latest&count=20'

# A tweet and its replies
curl 'http://127.0.0.1:19816/replies/1234567890123456789?count=40'
```

Response shape:

```json
[
  {
    "id": "1820...",
    "text": "full tweet text",
    "created_at": "Mon Apr 21 10:30:00 +0000 2026",
    "user": { "id": "...", "name": "Alice", "screen_name": "alice" },
    "favorite_count": 42,
    "retweet_count": 3,
    "reply_count": 7,
    "quote_count": 1,
    "view_count": 1200,
    "lang": "en",
    "is_reply": false,
    "conversation_id": "1820...",
    "url": "https://x.com/alice/status/1820..."
  }
]
```

### Endpoints

| Route | Purpose |
|---|---|
| `GET /search?q=&type=Top\|Latest&count=` | Enqueue a search, wait for capture (up to 60s), return tweets |
| `GET /replies/{tweet_id}?count=` | Fetch a tweet + its replies, `[main, reply1, ...]` |
| `GET /queries` | Internal: userscript polls this for pending jobs |
| `POST /captured` | Internal: userscript POSTs captured GraphQL JSON here |
| `POST /abort` | Internal: userscript cancels a timed-out job |
| `GET /debug/recent` | Last 20 captures (op / url / body length) for inspection |

## Is it generic?

Yes. The service has zero knowledge of who's calling. Use it from cron, a background agent, a notebook, a shell script — anything that speaks HTTP. There are no hardcoded queries or URLs; the caller picks what to search for.

## Caveats

- The bridge tab must stay open and logged in. Minimize the window and forget about it.
- Queries are serial (one navigation at a time in one tab). ~3–7s per query in practice. This is not a high-throughput API.
- The bridge tab reloads itself between jobs. If you also want to use that tab for regular browsing, use a separate Chrome window for the bridge.
- X rate limits still apply at the account level. Don't hammer.
- X can change response shapes without notice. When they do, edit `parse_search` / `parse_tweet_detail` in `service/bridge.py`. Use `GET /debug/recent` to inspect a raw capture first.

## Self-healing (optional)

Because the userscript auto-updates from this repo and the parser lives in `service/bridge.py`, an automation loop can:

1. Run a periodic health check: `curl /search?q=test&count=1` — expect non-empty.
2. On repeated failure: fetch a raw capture via `/debug/recent`, diff against current parsers, patch, push to `main`.
3. On the consumer side, `git pull` + restart the service. Userscript updates via `@updateURL` within 24h.

This turns library rot into a self-resolving problem instead of a hard blocker.

## Security

- Service binds to `127.0.0.1` only. Don't expose it.
- The userscript only POSTs to `localhost` / `127.0.0.1`. Tampermonkey's `@connect` directive enforces this.
- No credentials leave your machine. Your browser's existing session cookies handle auth to X.

## License

MIT.
