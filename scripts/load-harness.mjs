// SYNTHETIC LOAD HARNESS: generated market data, not Hyperliquid data.
//
// Replaces WebSocket and the two REST calls inside a headless Chrome test page only, then drives the
// unmodified app (feed parsing, frame buffer, store, React panels, chart adapter) with a sustained
// load and one burst, and measures what reaches the screen and how responsive the page stays.
// Nothing here ships with the app.
//
//   npm run build && npm run preview            # production build on http://127.0.0.1:4173/
//   node scripts/load-harness.mjs http://127.0.0.1:4173/ [--throttle 4]
//   npm run dev                                 # dev build adds React commit counts (?profile=1)
//   node scripts/load-harness.mjs http://127.0.0.1:5173/ --dev
//
// CHROME_PATH overrides the Chrome binary. Results and a screenshot go to $TMPDIR/hl-load.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const APP = args.find(a => a.startsWith('http')) ?? 'http://127.0.0.1:4173/';
const DEV = args.includes('--dev');
const THROTTLE = Number(args[args.indexOf('--throttle') + 1] ?? 1) || 1;
const LOAD = { warmupSeconds: 3, seconds: 30, bookPerSecond: 200, tradeBatchesPerSecond: 100, tradesPerBatch: 10, candlesPerSecond: 50,
  burst: { book: 3000, tradeBatches: 1500, candles: 500 } };
// Pass limits, fixed before running.
const LIMITS = { longestTaskMs: 200, longTaskShare: 0.2, frameP95Ms: 50, timerLagP95Ms: 50, inputMaxMs: 200, burstRecoverMs: 1000 };
const OUT = join(tmpdir(), 'hl-load'); mkdirSync(OUT, { recursive: true });
const label = `${DEV ? 'dev' : 'production'}${THROTTLE > 1 ? `-cpu${THROTTLE}x` : ''}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail); };

// ---- Chrome over CDP --------------------------------------------------------
const PORT = 9335, PROFILE = join(tmpdir(), 'hl-load-chrome');
rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
let version; for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let nextId = 1; const pending = new Map(); const handlers = {};
ws.onmessage = e => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  else if (m.method) handlers[m.method]?.(m.params); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const waitFor = async (what, expression, timeout = 20_000) => { const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(expression)) return true; } catch {} await sleep(100); }
  throw new Error(`timeout waiting for ${what}`); };
const heapMb = async () => { await send('HeapProfiler.collectGarbage'); const { usedSize } = await send('Runtime.getHeapUsage'); return +(usedSize / 1e6).toFixed(1); };
const domNodes = async () => (await send('Performance.getMetrics')).metrics.find(m => m.name === 'Nodes').value;

// ---- Synthetic REST: market list and candle history --------------------------
handlers['Fetch.requestPaused'] = async p => {
  const body = p.request.postData ?? '';
  let data = null;
  if (body.includes('"meta"')) data = { universe: [{ name: 'BTC', szDecimals: 5 }, { name: 'ETH', szDecimals: 4 }] };
  if (body.includes('candleSnapshot')) {
    const now = Math.floor(Date.now() / 60_000);
    data = Array.from({ length: 200 }, (_, i) => { const t = (now - 200 + i) * 60_000;
      return { t, T: t + 59_999, s: 'BTC', i: '1m', o: '50000', c: '50010', h: '50020', l: '49990', v: '1', n: 1 }; });
  }
  if (!data) return send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  await send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
    body: Buffer.from(JSON.stringify(data)).toString('base64') }).catch(() => {});
};

// ---- In-page: synthetic socket, generator, probes -----------------------------
const PAGE = `(() => {
  const LOAD = ${JSON.stringify(LOAD)};
  // Visible label on the page under test.
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.textContent = 'SYNTHETIC LOAD TEST: generated data, not Hyperliquid';
    banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;background:#8a2be2;color:#fff;font:600 13px system-ui;text-align:center;padding:6px';
    document.body.appendChild(banner);
  });

  const state = { socket: null, mid: 50000, bookTime: 0, lastBook: null, tid: 0, trades: new Map(), sent: { book: 0, tradeBatches: 0, candles: 0 }, timer: null };
  const round = x => Math.round(x * 100) / 100;
  const book = () => { state.mid = round(state.mid + (Math.random() - 0.5) * 4); state.bookTime += 1;
    const levels = [Array.from({ length: 20 }, (_, i) => ({ px: String(round(state.mid - 0.5 - i)), sz: String(1 + i), n: 1 })),
      Array.from({ length: 20 }, (_, i) => ({ px: String(round(state.mid + 0.5 + i)), sz: String(1 + i), n: 1 }))];
    state.lastBook = { bid: +levels[0][0].px, ask: +levels[1][0].px, time: state.bookTime };
    state.sent.book++; return { channel: 'l2Book', data: { coin: 'BTC', time: state.bookTime, levels } }; };
  const trades = () => { const batch = [];
    for (let i = 0; i < LOAD.tradesPerBatch; i++) {
      // About one trade in five repeats a recent tid to exercise deduplication.
      const tid = Math.random() < 0.2 && state.tid > 20 ? state.tid - Math.floor(Math.random() * 20) : ++state.tid;
      const t = { coin: 'BTC', tid, time: 1_700_000_000_000 + tid, px: (1000 + tid / 100).toFixed(2), sz: '0.01', side: tid % 2 ? 'B' : 'A' };
      state.trades.set(tid, t); batch.push(t);
      // Keep the harness's own bookkeeping bounded so heap readings measure the app.
      if (state.trades.size > 1000) state.trades.delete(state.trades.keys().next().value);
    }
    batch.sort(() => Math.random() - 0.5); state.sent.tradeBatches++; return { channel: 'trades', data: batch }; };
  const candle = () => { const t = Math.floor(Date.now() / 60_000) * 60_000; const c = round(state.mid);
    state.sent.candles++; return { channel: 'candle', data: { t, T: t + 59_999, s: 'BTC', i: '1m', o: '50000', c: String(c),
      h: String(Math.max(50000, c) + 5), l: String(Math.min(50000, c) - 5), v: '1', n: 1 } }; };
  const deliver = message => state.socket?.readyState === 1 && state.socket.onmessage?.({ data: JSON.stringify(message) });

  class SyntheticSocket {
    constructor() { this.readyState = 0; state.socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 20); }
    send(data) { const m = JSON.parse(data); if (m.method === 'subscribe') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ channel: 'subscriptionResponse', data: m }) }), 5); }
    close() { this.readyState = 3; if (state.socket === this) state.socket = null; }
  }
  const Native = window.WebSocket;
  window.WebSocket = Object.assign(function (url, protocols) {
    return String(url).includes('hyperliquid') ? new SyntheticSocket() : new Native(url, protocols);
  }, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // Steady load: a 10 ms tick with fractional carry so rates hold even when ticks slip.
  window.__load = {
    state,
    start() { let last = performance.now(), carry = { book: 0, trades: 0, candles: 0 };
      state.timer = setInterval(() => { const now = performance.now(), dt = (now - last) / 1000; last = now;
        carry.book += LOAD.bookPerSecond * dt; carry.trades += LOAD.tradeBatchesPerSecond * dt; carry.candles += LOAD.candlesPerSecond * dt;
        for (; carry.book >= 1; carry.book--) deliver(book());
        for (; carry.trades >= 1; carry.trades--) deliver(trades());
        for (; carry.candles >= 1; carry.candles--) deliver(candle());
      }, 10); },
    stop() { clearInterval(state.timer); },
    burst() { const t0 = performance.now(); const b = LOAD.burst;
      for (let i = 0; i < Math.max(b.book, b.tradeBatches, b.candles); i++) {
        if (i < b.book) deliver(book()); if (i < b.tradeBatches) deliver(trades()); if (i < b.candles) deliver(candle());
      }
      return performance.now() - t0; },
    expectedTrades() { return [...state.trades.values()].sort((a, b) => b.time - a.time || b.tid - a.tid).slice(0, 50).map(t => t.px); },
  };

  // Responsiveness probes: long tasks, frame intervals, timer lag, input event duration.
  const probe = window.__probe = { longTasks: [], frames: [], lag: [], events: [], running: false };
  new PerformanceObserver(list => { if (probe.running) for (const e of list.getEntries()) probe.longTasks.push(e.duration); }).observe({ type: 'longtask' });
  new PerformanceObserver(list => { if (probe.running) for (const e of list.getEntries()) if (e.name === 'keydown') probe.events.push(e.duration); })
    .observe({ type: 'event', durationThreshold: 16 });
  probe.start = () => { Object.assign(probe, { longTasks: [], frames: [], lag: [], events: [], running: true, t0: performance.now() });
    let prev = performance.now(); const frame = now => { if (!probe.running) return; probe.frames.push(now - prev); prev = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    let expected = performance.now() + 50; probe.lagTimer = setInterval(() => { const now = performance.now(); probe.lag.push(Math.max(0, now - expected)); expected = now + 50; }, 50); };
  probe.stop = () => { probe.running = false; clearInterval(probe.lagTimer); const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : 0; };
    const elapsed = performance.now() - probe.t0, longTotal = probe.longTasks.reduce((a, b) => a + b, 0);
    return { elapsedMs: Math.round(elapsed), frames: probe.frames.length, frameP50Ms: pct(probe.frames, 0.5), frameP95Ms: pct(probe.frames, 0.95), frameMaxMs: pct(probe.frames, 1),
      longTasks: probe.longTasks.length, longestTaskMs: +Math.max(0, ...probe.longTasks).toFixed(1), longTaskShare: +(longTotal / elapsed).toFixed(3),
      timerLagP95Ms: pct(probe.lag, 0.95), timerLagMaxMs: pct(probe.lag, 1),
      inputEventsOver16Ms: probe.events.length, inputMaxMs: +Math.max(0, ...probe.events).toFixed(1) }; };
})()`;

// What the screen shows, read from the DOM with the app's own number format.
const SCREEN = `(() => { const fmt = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const cells = sel => [...document.querySelectorAll(sel)].map(e => e.textContent.trim());
  const bids = cells('.book-side.bids .book-row > span[role=cell]:nth-child(2)');
  const asks = cells('.book-side.asks .book-row > span[role=cell]:nth-child(2)');
  const last = window.__load.state.lastBook;
  return { bestBid: bids[0], bestAsk: asks.at(-1), expectedBid: fmt(last.bid), expectedAsk: fmt(last.ask),
    tradePrices: cells('.trades-scroll tbody tr td:first-child'), expectedTrades: window.__load.expectedTrades().map(p => fmt(+p)),
    sent: window.__load.state.sent }; })()`;

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*hyperliquid-testnet.xyz/info*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE });
  console.log(`${version.Browser} · ${label} · ${APP}`);
  console.log('SYNTHETIC LOAD:', JSON.stringify(LOAD));

  await send('Page.navigate', { url: APP + (DEV ? '?profile=1' : '') });
  await waitFor('market selected', `document.querySelector('#market')?.value === 'BTC'`);
  await waitFor('synthetic socket live and history drawn', `document.querySelector('.connection')?.textContent === 'Connected' && !document.querySelector('.chart-empty')`);
  if (THROTTLE > 1) await send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  // Warm-up: fill the book, tape and chart first, so baselines and counters exclude the one-time
  // empty-to-filled transition (first rows rendered, freshness flags turning true).
  await evaluate('window.__load.start(), true');
  await sleep(LOAD.warmupSeconds * 1000);

  // Dev only: record React commits and chart API calls with the app's own counters.
  if (DEV) await evaluate(`(async () => {
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => new URL(n).pathname === '/src/perf/metrics.ts');
    window.__metrics = await import(url);
    window.__run = window.__metrics.startRecording(['Header','ConnectionStatus','MarketSelector','MarketSummary','PriceChart','TradesTape','OrderBook','bookMessages','tradeBatches','seriesUpdate','seriesSetData'], 600000);
    return true; })()`);

  // Calibrate the long-task probe: it must see a planted 60 ms timer task.
  const calibration = await evaluate(`new Promise(r => { const seen = [];
    const o = new PerformanceObserver(l => seen.push(...l.getEntries().map(e => e.duration))); o.observe({ type: 'longtask' });
    setTimeout(() => { const t = performance.now(); while (performance.now() - t < 60); }, 0);
    setTimeout(() => { o.disconnect(); r(Math.round(Math.max(0, ...seen))); }, 400); })`);
  check('probe calibration: long-task observer reports a planted 60 ms task', calibration >= 60, `reported ${calibration} ms`);

  const heapStart = await heapMb(), nodesStart = await domNodes();

  // Phase 1: sustained load (already running), with a key press every 500 ms to measure input responsiveness.
  await evaluate('window.__probe.start(), true');
  for (let t = 0; t < LOAD.seconds * 2; t++) {
    await sleep(500);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  }
  const steady = await evaluate('window.__probe.stop()');
  await evaluate('window.__load.stop(), true');
  await sleep(300);
  const afterSteady = await evaluate(SCREEN);
  const heapSteady = await heapMb(), nodesSteady = await domNodes();
    await send('Page.captureScreenshot', { format: 'png' }).then(({ data }) => writeFileSync(join(OUT, `${label}.png`), Buffer.from(data, 'base64')));

  // Phase 2: one synchronous burst, then time until the newest book is on screen.
  await evaluate('window.__probe.start(), true');
  // Run the burst as an ordinary page task: work done inside a DevTools evaluate call is not reported
  // as a long task, so it would hide from the probe.
  const burstTaskMs = await evaluate(`new Promise(r => setTimeout(() => r(window.__load.burst()), 0))`);
  const recoverStart = Date.now();
  await waitFor('newest book on screen after burst', `(() => { const s = ${SCREEN}; return s.bestBid === s.expectedBid && s.bestAsk === s.expectedAsk; })()`, 10_000);
  const recoverMs = Date.now() - recoverStart;
  await sleep(1000);
  const burst = await evaluate('window.__probe.stop()');
  const afterBurst = await evaluate(SCREEN);
  const heapBurst = await heapMb(), nodesBurst = await domNodes();
  const devAfter = DEV ? await evaluate('window.__run.counts') : null;
  if (THROTTLE > 1) await send('Emulation.setCPUThrottlingRate', { rate: 1 });

  // ---- Checks -------------------------------------------------------------------
  const sent = afterBurst.sent;
  console.log('sent (synthetic):', JSON.stringify(sent));
  for (const [when, s] of [['after sustained load', afterSteady], ['after burst', afterBurst]]) {
    check(`${when}: newest book snapshot is on screen`, s.bestBid === s.expectedBid && s.bestAsk === s.expectedAsk,
      `screen ${s.bestBid}/${s.bestAsk}, last sent ${s.expectedBid}/${s.expectedAsk}`);
    check(`${when}: the 50 trade rows are exactly the newest 50 unique trades`, JSON.stringify(s.tradePrices) === JSON.stringify(s.expectedTrades),
      `rows ${s.tradePrices.length}, first ${s.tradePrices[0]} vs ${s.expectedTrades[0]}`);
  }
  check('bounded: DOM node count does not grow with load', nodesBurst <= nodesStart * 1.1 + 50, `nodes ${nodesStart} -> ${nodesSteady} -> ${nodesBurst}`);
  check('bounded: JS heap after GC does not grow with load', heapBurst <= heapStart * 1.5 + 5, `heap MB ${heapStart} -> ${heapSteady} -> ${heapBurst}`);
  if (DEV) {
    const c = devAfter;
    console.log('dev counters (steady + burst):', JSON.stringify(c));
    check('chart kept updating through the chart API', c.seriesUpdate > 0, `seriesUpdate ${c.seriesUpdate}, seriesSetData ${c.seriesSetData}`);
    check('chart updates caused no PriceChart React commits', c.PriceChart === 0, `PriceChart commits ${c.PriceChart}`);
    check('shell did not re-render under load', c.Header === 0 && c.MarketSelector === 0 && c.ConnectionStatus === 0, JSON.stringify({ Header: c.Header, MarketSelector: c.MarketSelector, ConnectionStatus: c.ConnectionStatus }));
    check('book commits are bounded by frames, not messages', c.OrderBook < c.bookMessages / 2, `OrderBook commits ${c.OrderBook} for ${c.bookMessages} book messages`);
  }
  console.log('steady responsiveness:', JSON.stringify(steady));
  console.log('burst:', JSON.stringify({ burstTaskMs: Math.round(burstTaskMs), recoverMs, ...burst }));
  check(`steady: no task longer than ${LIMITS.longestTaskMs} ms`, steady.longestTaskMs <= LIMITS.longestTaskMs, `longest ${steady.longestTaskMs} ms, ${steady.longTasks} long tasks`);
  check(`steady: long tasks under ${LIMITS.longTaskShare * 100}% of the time`, steady.longTaskShare <= LIMITS.longTaskShare, `share ${steady.longTaskShare}`);
  check(`steady: 95th percentile frame interval at most ${LIMITS.frameP95Ms} ms`, steady.frameP95Ms <= LIMITS.frameP95Ms, `p50 ${steady.frameP50Ms}, p95 ${steady.frameP95Ms}, max ${steady.frameMaxMs} ms`);
  check(`steady: 95th percentile timer lag at most ${LIMITS.timerLagP95Ms} ms`, steady.timerLagP95Ms <= LIMITS.timerLagP95Ms, `p95 ${steady.timerLagP95Ms}, max ${steady.timerLagMaxMs} ms`);
  check(`steady: key presses handled within ${LIMITS.inputMaxMs} ms`, steady.inputMaxMs <= LIMITS.inputMaxMs, `${steady.inputEventsOver16Ms} events over 16 ms, max ${steady.inputMaxMs} ms`);
  check(`burst: newest data on screen within ${LIMITS.burstRecoverMs} ms`, recoverMs <= LIMITS.burstRecoverMs, `recovered in ${recoverMs} ms after a ${Math.round(burstTaskMs)} ms burst task`);
  check('burst: the long-task probe saw the burst task when it exceeded 50 ms', burstTaskMs < 50 || burst.longTasks > 0, `burst task ${Math.round(burstTaskMs)} ms, long tasks ${burst.longTasks}, longest ${burst.longestTaskMs} ms`);

  writeFileSync(join(OUT, `${label}.json`), JSON.stringify({ synthetic: true, chrome: version.Browser, label, app: APP, load: LOAD, limits: LIMITS,
    sent, steady, burst: { burstTaskMs, recoverMs, ...burst }, heapMb: [heapStart, heapSteady, heapBurst], domNodes: [nodesStart, nodesSteady, nodesBurst],
    devCounters: devAfter, results }, null, 2));
} catch (error) {
  check('harness completed', false, String(error?.stack ?? error));
} finally {
  const failed = results.filter(r => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} checks passed (${label}, synthetic load)`);
  ws.close(); chrome.kill(); process.exit(failed ? 1 : 0);
}
