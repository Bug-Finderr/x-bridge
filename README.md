# x-bridge

x-bridge is a localhost API for browser-backed X data ingestion.

It uses a logged-in Chrome tab, injects a capture script through CDP, and parses the GraphQL responses X already sends to that tab.

## Runtime Shape

- Service: `http://127.0.0.1:19816`
- CDP target: `http://127.0.0.1:18800`
- Bridge tab: `https://x.com/home?bridge=1`
- Flow: API request -> `/queries` job -> X navigation -> `/captured` response -> parsed JSON

## Install

```bash
git clone https://github.com/Bug-Finderr/x-bridge
cd x-bridge/service
node main.ts
```

Start Chrome with remote debugging on `127.0.0.1:18800`, sign into X, then open:

```text
https://x.com/home?bridge=1
```

## Optional Browser Launcher

Set `XBRIDGE_START_SCRIPT` if the service should run your browser launcher before bridge checks. Otherwise, keep Chrome open manually.

Related environment variables:

```text
XBRIDGE_HOST=127.0.0.1
XBRIDGE_PORT=19816
XBRIDGE_CDP_BASE=http://127.0.0.1:18800
XBRIDGE_START_SCRIPT=/path/to/launcher
XBRIDGE_JOB_TIMEOUT=120
XBRIDGE_IDLE_SECONDS=600
```

`XBRIDGE_BROWSER_PROFILE_DIR` is only for managed browser cleanup. It is not required for manual Chrome sessions.

The service is native Node TypeScript. Keep source syntax erasable so Node can run `main.ts` directly without a build step.

## API

```bash
curl 'http://127.0.0.1:19816/health'
curl 'http://127.0.0.1:19816/search?q=AI+agents&type=Top&count=10'
curl 'http://127.0.0.1:19816/search?q=AI+agents&type=Latest&count=10'
curl 'http://127.0.0.1:19816/replies/<tweet_id>?count=40'
curl 'http://127.0.0.1:19816/debug/bridge'
curl 'http://127.0.0.1:19816/debug/recent'
```

Internal bridge endpoints:

```text
GET  /queries
POST /captured
POST /abort
```

## Response Shape

`/search` returns a JSON array of tweet objects.

```json
[
  {
    "id": "1781...",
    "text": "Example tweet text",
    "created_at": "Fri Apr 17 09:12:04 +0000 2026",
    "user": {
      "id": "123",
      "name": "Example User",
      "screen_name": "example"
    },
    "favorite_count": 12,
    "retweet_count": 3,
    "reply_count": 1,
    "quote_count": 0,
    "view_count": 1200,
    "lang": "en",
    "is_reply": false,
    "conversation_id": "1781...",
    "url": "<x_status_url>"
  }
]
```

`/replies/{tweet_id}` returns the main tweet followed by parsed replies.

## Debugging

```bash
curl 'http://127.0.0.1:19816/debug/bridge'
```

A ready bridge has:

- `bridge_tab_open: true`
- `bridge_last_poll_seconds` close to zero
- `pending_jobs: 0` when idle

`/debug/recent` returns recent raw captures for parser work.

## Boundaries

- The parser is X-specific.
- CDP injection can be adapted to other SPAs, but each target needs its own navigation, capture filters, parser, and safety rules.
- Mutating actions such as posting, liking, following, retweeting, and DMs are outside this project.

Apache-2.0.
