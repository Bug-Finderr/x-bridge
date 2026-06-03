# x-bridge

Read-only X/Twitter search and replies through a logged-in Chrome tab.

## Runtime

- Service: FastAPI on `127.0.0.1:19816`.
- Browser: Chrome with CDP on `127.0.0.1:18800`.
- Flow: API request -> wake Chrome -> open `x.com/home?bridge=1` -> CDP-inject bridge script -> capture X GraphQL -> parse tweets.
- Tampermonkey/GreasyFork is not required for archbox runtime. `x-bridge.user.js` is legacy fallback only.

## Install

```bash
git clone https://github.com/Bug-Finderr/x-bridge
cd x-bridge/service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Set `XBRIDGE_START_SCRIPT` if the service should launch Chrome on demand.

## API

```bash
curl 'http://127.0.0.1:19816/search?q=AI+agents&type=Top&count=10'
curl 'http://127.0.0.1:19816/replies/<tweet_id>?count=40'
curl 'http://127.0.0.1:19816/debug/bridge'
curl 'http://127.0.0.1:19816/debug/recent'
```

## Smoke Test

A healthy bridge returns a real result and a fresh `bridge_last_poll_seconds`.

```bash
/home/bug/.openclaw/workspace/scripts/xbridge-smoke.sh OpenClaw Top 1
```

`/health` alone is not enough.

## Notes

- Current parser is X-specific. CDP injection can generalize, but each SPA needs its own navigation, capture filters, parser, and safety rules.
- Read-only only. Do not add post, like, retweet, follow, or DM actions.
- Parser drift is fixed in `service/bridge.py`, then copied to the live OpenClaw skill.

Apache-2.0.
