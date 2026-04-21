# x-bridge

Browser userscript that ferries `x.com` GraphQL responses to a local HTTP service.

## Why

Python scrapers for X (twikit, twscrape, tweety-ns) all depend on generating the `x-client-transaction-id` header by parsing an obfuscated `ondemand.s.*.js` file shipped by X. As of March 2026, X stopped shipping that file under the old naming convention — see [XClientTransaction#35](https://github.com/iSarabjitDhiman/XClientTransaction/issues/35). Every downstream lib broke.

Inside a real logged-in Chrome tab, X's own JS generates valid transaction IDs on its own. This userscript stops fighting the library-side reimplementation and instead intercepts the responses X's own app already makes.

## How it works

1. Runs on every `x.com/*` page at `document-start`.
2. Monkey-patches `window.fetch` and `XMLHttpRequest` to peek at GraphQL responses.
3. When it sees `SearchTimeline`, `UserTweets`, `TweetDetail`, etc., it POSTs the raw JSON body to `http://127.0.0.1:19816/captured`.
4. The "bridge tab" (URL contains `?bridge=1`) polls `http://127.0.0.1:19816/queries` for pending jobs. On a new job, it navigates to the matching search/status URL — X renders the page, the userscript captures the response, the local service wakes the waiting agent.

Effectively the browser is the scraper. The local service is just a queue and a parser.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Tampermonkey Dashboard → Utilities → "Import from URL":
   ```
   https://raw.githubusercontent.com/Bug-Finderr/x-bridge/main/x-bridge.user.js
   ```
3. Open `https://x.com/home?bridge=1` in its own pinned window. That tab is the bridge — do not close it.

Auto-updates are wired via `@updateURL`/`@downloadURL`. Tampermonkey re-pulls from this repo.

## Local service contract

The userscript talks to `127.0.0.1:19816`. Expected endpoints:

- `GET /queries` → `{ "queue": [ { "id": "j_…", "kind": "search"|"tweet", "q": "…", "type": "Top"|"Latest", "tweet_id": "…" } ] }`
- `POST /captured` ← `{ "op": "SearchTimeline"|…, "url": "…", "body": "<raw JSON string>", "jobid": "j_…" | null, "captured_at": "ISO" }`

Reference implementation: [Bug-Finderr/claw-brain](https://github.com/Bug-Finderr/claw-brain) (`skills/auto-tweet/main.py` + `bridge.py`).

## License

MIT.
