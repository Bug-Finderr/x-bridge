# x-bridge

Browser-assisted access to the `x.com` GraphQL API for scripts, agents, and automation.

## Why this exists

Unofficial X scraper libraries — [twikit](https://github.com/d60/twikit), [twscrape](https://github.com/vladkens/twscrape), [tweety-ns](https://github.com/mahrtayyab/tweety), and friends — all depend on generating the `x-client-transaction-id` header by parsing an obfuscated `ondemand.s.*.js` file shipped by X. Around March 2026 X changed how that file is named and served, and every downstream library broke at once ([XClientTransaction#35](https://github.com/iSarabjitDhiman/XClientTransaction/issues/35), [twikit#417](https://github.com/d60/twikit/issues/417)). Every library in this space is chasing the same moving target.

Inside a real logged-in Chrome tab, X's own JavaScript generates valid transaction IDs on its own. x-bridge stops fighting the reimplementation problem. **The browser is the scraper; this service is just a queue and a parser.**

## How it works

```
  your agent / cron / script
         │  (HTTP to localhost)
         ▼
  ┌──────────────────┐          ┌─────────────────────┐
  │ bridge service   │◀────────▶│ x-bridge userscript │
  │ FastAPI, :19816  │  jobs +  │ Chrome, logged in   │
  │                  │ captures │ to x.com            │
  └──────────────────┘          └─────────────────────┘
                                          │
                                  navigates + lets X's
                                  own JS do the request
                                          ▼
                                      x.com
```

Your agent submits `GET /search?q=...`. The userscript in your bridge tab polls the service, picks up the job, navigates the tab to `x.com/search?q=...`, and lets X render the page. A `fetch`/`XHR` interceptor grabs the raw `SearchTimeline` response and POSTs it back. The service parses and returns normalized tweets.

Supported GraphQL ops out of the box: `SearchTimeline`, `UserTweets`, `UserTweetsAndReplies`, `HomeTimeline`, `HomeLatestTimeline`, `TweetDetail` (tweet + replies). Add more by editing `CAPTURE_OPS` in the userscript.

X serves a nonce-based CSP that blocks inline script injection. x-bridge patches `window.fetch` / `XMLHttpRequest` via Tampermonkey's `unsafeWindow` handle — extension privileges bypass CSP cleanly.

## Install

**Userscript:**

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Install the userscript via [Greasy Fork](https://greasyfork.org/en/scripts/574864-x-bridge-claw) or Tampermonkey Dashboard > Utilities > "Import from URL":
   `https://raw.githubusercontent.com/Bug-Finderr/x-bridge/main/x-bridge.user.js`
3. Approve the `unsafeWindow` + `@connect 127.0.0.1` prompts on install.
4. Open `https://x.com/home?bridge=1` in its own pinned Chrome window. Keep it open.

Updates land automatically via `@updateURL`.

**Reference service:**

```bash
git clone https://github.com/Bug-Finderr/x-bridge
cd x-bridge/service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Server listens on `127.0.0.1:19816`. Swagger docs at `http://127.0.0.1:19816/docs`.

## Usage

```bash
curl 'http://127.0.0.1:19816/search?q=AI+agents&type=Top&count=10'
curl 'http://127.0.0.1:19816/search?q=founding+engineer&type=Latest&count=20'
curl 'http://127.0.0.1:19816/replies/1820000000000000000?count=40'
```

Response shape per tweet: `id`, `text`, `created_at`, `user{id,name,screen_name}`, `favorite_count`, `retweet_count`, `reply_count`, `quote_count`, `view_count`, `lang`, `is_reply`, `conversation_id`, `url`.

| Route | Purpose |
|---|---|
| `GET /search?q=&type=Top\|Latest&count=` | Enqueue a search, return tweets (up to 60s) |
| `GET /replies/{id}?count=` | Fetch a tweet + replies |
| `GET /queries` | Userscript polls this for pending jobs |
| `POST /captured` | Userscript POSTs captured responses here |
| `POST /abort` | Userscript cancels timed-out jobs |
| `GET /debug/recent` | Last 20 captures for inspection |

## Caveats

- Bridge tab must stay open and logged in. One tab, one Chrome window, minimized is fine.
- Queries are serial, ~3–7s per query. Not a high-throughput API.
- The bridge tab reloads itself between jobs, so use a dedicated window.
- X rate limits apply at the account level.
- When X changes response shapes, edit `parse_search` / `parse_tweet_detail` in `service/bridge.py`. Inspect raw captures via `GET /debug/recent`.

## Self-healing

This repo is actively maintained by an OpenClaw agent instance that health-checks the endpoints on a schedule and patches parser/userscript drift when X changes response shapes. Expect the `main` branch to stay current.

The same pattern works for anyone downstream: health-check `/search?q=test&count=1`, and on failure fetch a raw capture from `/debug/recent`, patch `service/bridge.py`, push. Consumers `git pull` + restart; the userscript updates via `@updateURL`. Library rot becomes a self-resolving problem.

## Security

Service binds to `127.0.0.1` only. The userscript's `@connect` restricts outbound traffic to loopback. No credentials leave your machine — your browser's existing session handles auth.

If my Twitter account gets banned because of this tool, I will put a giant red banner on top of this README and take down the Greasy Fork listing. Use at your own risk.

## License

Apache 2.0.
