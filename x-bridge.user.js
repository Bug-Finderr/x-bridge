// ==UserScript==
// @name         X Bridge (claw)
// @namespace    https://github.com/Bug-Finderr/x-bridge
// @version      0.1.0
// @description  Ferries x.com GraphQL responses to a local service, replacing dead TID-based scrapers. Bridge tab polls queue and drives searches.
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
  const CAPTURE_OPS = new Set(['SearchTimeline', 'UserTweets', 'UserTweetsAndReplies', 'HomeTimeline', 'HomeLatestTimeline', 'TweetDetail']);
  const POLL_MS = 5000;

  const params = new URLSearchParams(location.search);
  const bridgeOn = params.has('bridge');
  if (bridgeOn) sessionStorage.setItem('claw_bridge', '1');
  const IS_BRIDGE = sessionStorage.getItem('claw_bridge') === '1';
  const JOBID = params.get('jobid') || null;

  const log = (...a) => console.log('[x-bridge]', ...a);

  const opFromUrl = (url) => {
    const m = String(url).match(/\/i\/api\/graphql\/[^/]+\/([A-Za-z0-9_]+)/);
    return m ? m[1] : null;
  };

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

  const emit = (op, url, bodyText) =>
    gmPost('/captured', {
      op,
      url,
      body: bodyText,
      jobid: JOBID,
      captured_at: new Date().toISOString(),
    }).catch(() => {});

  // ---- fetch interceptor ----
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const op = opFromUrl(url);
    const resp = await origFetch.apply(this, arguments);
    if (op && CAPTURE_OPS.has(op)) {
      try {
        const clone = resp.clone();
        clone.text().then((t) => emit(op, url, t));
      } catch (_) {}
    }
    return resp;
  };

  // ---- XHR interceptor ----
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    const origOpen = xhr.open;
    xhr.open = function (m, u) { _url = u; return origOpen.apply(xhr, arguments); };
    xhr.addEventListener('load', function () {
      const op = opFromUrl(_url);
      if (op && CAPTURE_OPS.has(op)) {
        try { emit(op, _url, xhr.responseText); } catch (_) {}
      }
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  if (!IS_BRIDGE) return;

  log('bridge mode active, jobid=', JOBID);

  // When a job completes (capture POSTed for this jobid), go back to /home?bridge=1
  // Heuristic: after we emit with a matching jobid, wait 2s and redirect home so we can poll again.
  if (JOBID) {
    let finished = false;
    const watchdog = setTimeout(() => {
      if (!finished) { log('job timeout, returning home'); location.href = '/home?bridge=1'; }
    }, 25000);
    // Hook: when any capture emits with current jobid, schedule return after 2s
    const origEmit = emit;
    // re-wrap: use a flag set by patching emit via closure — redo by monkey-patch on next call
    // simplest: poll server for job completion instead
    const poll = setInterval(async () => {
      const j = await gmGet('/queries');
      if (!j) return;
      const stillPending = Array.isArray(j.queue) && j.queue.some((q) => q.id === JOBID);
      if (!stillPending) {
        finished = true;
        clearInterval(poll);
        clearTimeout(watchdog);
        log('job', JOBID, 'done, returning home');
        setTimeout(() => { location.href = '/home?bridge=1'; }, 500);
      }
    }, 2000);
  } else {
    // home/bridge tab: poll for new jobs
    setTimeout(function tick() {
      gmGet('/queries').then((j) => {
        if (j && Array.isArray(j.queue) && j.queue.length) {
          const job = j.queue[0];
          const f = job.type === 'Latest' ? 'live' : 'top';
          const target = `/search?q=${encodeURIComponent(job.q)}&src=typed_query&f=${f}&bridge=1&jobid=${encodeURIComponent(job.id)}`;
          log('picking job', job.id, target);
          location.href = target;
          return;
        }
        setTimeout(tick, POLL_MS);
      });
    }, 2000);
  }
})();
