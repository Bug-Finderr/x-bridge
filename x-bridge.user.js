// ==UserScript==
// @name         X Bridge (claw)
// @namespace    https://github.com/Bug-Finderr/x-bridge
// @version      0.2.0
// @description  Ferries x.com GraphQL responses to a local service. Bridge tab polls queue and drives searches. Patches fetch/XHR at the earliest possible point by injecting into page context.
// @match        https://x.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/Bug-Finderr/x-bridge/main/x-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/Bug-Finderr/x-bridge/main/x-bridge.user.js
// ==/UserScript==

(function () {
  'use strict';

  const LOCAL = 'http://127.0.0.1:19816';
  const CAPTURE_OPS = ['SearchTimeline', 'UserTweets', 'UserTweetsAndReplies', 'HomeTimeline', 'HomeLatestTimeline', 'TweetDetail'];
  const POLL_MS = 5000;
  const WATCHDOG_MS = 75000; // longer than server (60s) to avoid restart loop

  const params = new URLSearchParams(location.search);
  const bridgeOn = params.has('bridge');
  if (bridgeOn) sessionStorage.setItem('claw_bridge', '1');
  const IS_BRIDGE = sessionStorage.getItem('claw_bridge') === '1';
  const JOBID = params.get('jobid') || null;

  // ---- page-context injected interceptor ------------------------------------
  // Patch fetch/XHR as early as possible, before React caches them.
  const injected = `(() => {
    const OPS = ${JSON.stringify(CAPTURE_OPS)};
    const opFrom = (u) => {
      const m = String(u).match(/\\/i\\/api\\/graphql\\/[^/]+\\/([A-Za-z0-9_]+)/);
      return m ? m[1] : null;
    };
    const emit = (op, url, body) => window.dispatchEvent(new CustomEvent('claw-capture', { detail: { op, url, body } }));

    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const op = opFrom(url);
      const resp = await origFetch.apply(this, arguments);
      if (op && OPS.includes(op)) {
        try { resp.clone().text().then((t) => emit(op, url, t)).catch(() => {}); } catch (_) {}
      }
      return resp;
    };

    const OrigXHR = window.XMLHttpRequest;
    function PatchedXHR() {
      const xhr = new OrigXHR();
      let _url = '';
      const origOpen = xhr.open;
      xhr.open = function (m, u) { _url = u; return origOpen.apply(xhr, arguments); };
      xhr.addEventListener('load', function () {
        const op = opFrom(_url);
        if (op && OPS.includes(op)) {
          try { emit(op, _url, xhr.responseText); } catch (_) {}
        }
      });
      return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
  })();`;

  const injectNow = () => {
    const s = document.createElement('script');
    s.textContent = injected;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  };
  injectNow();

  // ---- listen for captures from the page context, POST to local service ----
  const gmPost = (path, body) =>
    new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: LOCAL + path,
        data: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
        onload: (r) => resolve(r),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });

  const gmGet = (path) =>
    new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: LOCAL + path,
        timeout: 5000,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); } },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });

  window.addEventListener('claw-capture', (e) => {
    const { op, url, body } = e.detail || {};
    console.log('[x-bridge] capture', op, (body || '').length, 'bytes');
    gmPost('/captured', {
      op, url, body,
      jobid: JOBID,
      captured_at: new Date().toISOString(),
    });
  });

  if (!IS_BRIDGE) return;

  console.log('[x-bridge] bridge mode, jobid=', JOBID);

  if (JOBID) {
    // On a job page: wait for capture to land (server marks job done) then go home.
    let finished = false;
    const watchdog = setTimeout(() => {
      if (finished) return;
      console.log('[x-bridge] watchdog fired, aborting + home');
      gmPost('/abort', { jobid: JOBID }).finally(() => { location.href = '/home?bridge=1'; });
    }, WATCHDOG_MS);
    const poll = setInterval(async () => {
      const j = await gmGet('/queries');
      if (!j) return;
      const stillPending = Array.isArray(j.queue) && j.queue.some((q) => q.id === JOBID);
      if (!stillPending) {
        finished = true;
        clearInterval(poll);
        clearTimeout(watchdog);
        console.log('[x-bridge] job done, home');
        setTimeout(() => { location.href = '/home?bridge=1'; }, 300);
      }
    }, 2000);
  } else {
    // Home/bridge tab: poll for new jobs.
    setTimeout(function tick() {
      gmGet('/queries').then((j) => {
        if (j && Array.isArray(j.queue) && j.queue.length) {
          const job = j.queue[0];
          let target;
          if (job.kind === 'search') {
            const f = job.type === 'Latest' ? 'live' : 'top';
            target = `/search?q=${encodeURIComponent(job.q)}&src=typed_query&f=${f}&bridge=1&jobid=${encodeURIComponent(job.id)}`;
          } else if (job.kind === 'tweet') {
            // Twitter status URLs accept any username path segment; 'i' is canonical-ish.
            target = `/i/status/${encodeURIComponent(job.tweet_id)}?bridge=1&jobid=${encodeURIComponent(job.id)}`;
          } else {
            setTimeout(tick, POLL_MS); return;
          }
          console.log('[x-bridge] picking job', job.id, target);
          location.href = target;
          return;
        }
        setTimeout(tick, POLL_MS);
      });
    }, 1500);
  }
})();
