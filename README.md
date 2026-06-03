# x-bridge

Browser-assisted access to X/Twitter search and replies for scripts, agents, and automation.

## Why this exists

Unofficial X scraper libraries break when X changes its authenticated GraphQL transaction/header machinery. x-bridge avoids reimplementing that moving target: a real logged-in Chrome tab performs the request, and the local service captures the response.

The browser is the scraper. The service is a queue, a Chrome DevTools Protocol injector, and an X response parser.

## How it works

```
your agent / cron / script
       |
       | HTTP localhost:19816
       v
+------------------+        CDP        +----------------------+
| bridge service   | <---------------> | logged-in Chrome tab |
| FastAPI + parser |                  | x.com/home?bridge=1  |
+------------------+                  +----------------------+
       ^                                      |
       | captured GraphQL JSON                | X's own JS/auth
       +--------------------------------------+
```

`GET /search?q=...` wakes the dedicated Chrome profile if needed, opens `x.com/home?bridge=1`, injects the bridge script through CDP, navigates the page to the requested X search, captures the GraphQL response, parses it, and returns normalized tweets.

Supported X GraphQL ops: `SearchTimeline`, `UserTweets`, `UserTweetsAndReplies`, `HomeTimeline`, `HomeLatestTimeline`, `TweetDetail`.

## Install

```bash
git clone https://github.com/Bug-Finderr/x-bridge
cd x-bridge/service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Run Chrome with remote debugging on `127.0.0.1:18800`, logged into X, or set `XBRIDGE_START_SCRIPT` so the service can launch the dedicated profile on demand.

Archbox/OpenClaw uses `~/start-bridge-tab.sh` and does not require Tampermonkey or GreasyFork at runtime. `x-bridge.user.js` is kept only as a legacy/public fallback source.

Optional env vars:

| Name | Default | Purpose |
|---|---|---|
| `XBRIDGE_HOST` | `127.0.0.1` | Service bind host |
| `XBRIDGE_PORT` | `19816` | Service port |
| `XBRIDGE_CDP_BASE` | `http://127.0.0.1:18800` | Chrome DevTools endpoint |
| `XBRIDGE_START_SCRIPT` | unset | Browser launcher used when Chrome is not ready |
| `XBRIDGE_BROWSER_PROFILE_DIR` | unset | Browser profile path for idle shutdown |
| `XBRIDGE_EXTRA_PATH` | unset | Extra PATH prefix for launcher scripts |
| `XBRIDGE_IDLE_SECONDS` | `600` | Idle seconds before closing the configured browser profile; `0` disables |
| `XBRIDGE_USERSCRIPT_READY_SECONDS` | `15` | Compatibility name for bridge poll freshness |

## Usage

```bash
curl 'http://127.0.0.1:19816/search?q=AI+agents&type=Top&count=10'
curl 'http://127.0.0.1:19816/search?q=founding+engineer&type=Latest&count=20'
curl 'http://127.0.0.1:19816/replies/1820000000000000000?count=40'
```

Response shape per tweet: `id`, `text`, `created_at`, `user{id,name,screen_name}`, `favorite_count`, `retweet_count`, `reply_count`, `quote_count`, `view_count`, `lang`, `is_reply`, `conversation_id`, `url`.

| Route | Purpose |
|---|---|
| `GET /search?q=&type=Top|Latest&count=` | Enqueue a search and return tweets |
| `GET /replies/{id}?count=` | Fetch a tweet plus replies |
| `GET /queries` | Bridge script polls this for pending jobs |
| `POST /captured` | Bridge script posts captured responses here |
| `POST /abort` | Bridge script cancels timed-out jobs |
| `GET /debug/recent` | Recent raw captures for parser repair |
| `GET /debug/bridge` | Browser, tab, queue, and poll freshness status |

## Smoke Test

A working bridge must return a real search result and a fresh bridge poll marker. `/health` alone is not enough.

```bash
curl 'http://127.0.0.1:19816/debug/bridge'
curl 'http://127.0.0.1:19816/search?q=OpenClaw&type=Top&count=1'
```

On OpenClaw archbox, use:

```bash
/home/bug/.openclaw/workspace/scripts/xbridge-smoke.sh OpenClaw Top 1
```

## Generalization

The CDP mechanism is not X-specific. Chrome can inject scripts into other pages and observe page network activity. The current service is X-specific because its job router, GraphQL op list, and parsers understand X response shapes. Supporting another SPA needs a site-specific module for navigation, capture filters, parsing, and safety rules.

## Caveats

- Requires a logged-in Chrome session for X.
- Queries are serial and browser-speed, not high throughput.
- X rate limits still apply to the logged-in account.
- Parser drift is still possible when X changes response shapes.
- The service is read-only by design. Do not add post/like/retweet/follow actions.

## Self-healing

OpenClaw consumer crons run the smoke test before relying on X. If smoke fails, they fall back to web/HN sources and dispatch the x-bridge repair agent. Repair agents should patch `service/bridge.py` for runtime/CDP/parser issues, copy it to the live OpenClaw skill, restart x-bridge, run the smoke test, commit, and push.

## Security

Service binds to `127.0.0.1` by default. Chrome keeps auth cookies in the browser profile; x-bridge captures API responses locally and does not export credentials.

## License

Apache 2.0.
