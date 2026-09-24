// Browser lifecycle checks against live testnet, driven over the Chrome DevTools Protocol.
// Needs a running dev server (the page imports /src/data/store.ts) and a local Chrome.
//   npm run dev
//   node scripts/verify-lifecycle.mjs [app-url]      (default http://127.0.0.1:5173/)
// CHROME_PATH overrides the Chrome binary. Screenshots and result.json go to $TMPDIR/hl-verify.
// Exit code 0 only if every check passes. Results depend on live testnet data.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = join(tmpdir(), 'hl-verify');
const SHOTS = join(OUT, 'shots');
const PORT = 9333;
const PROFILE = join(OUT, 'chrome-profile');
rmSync(PROFILE, { recursive: true, force: true }); mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(stamp(), ...a);
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); log(pass ? 'PASS' : 'FAIL', name, detail); };

// ---- Chrome + CDP -------------------------------------------------------
const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
let version;
for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let nextId = 1; const pending = new Map(); const handlers = {};
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  else if (m.method) handlers[m.method]?.(m.params);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const on = (method, fn) => { handlers[method] = fn; };
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (label, expression, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(expression)) return true; } catch {} await sleep(250); }
  log('timeout waiting for', label); return false;
};

// ---- WebSocket inventory -------------------------------------------------
const sockets = new Map(); // requestId -> { url, created, open, closed, subs:Set, recv:{} }
const openTimeline = []; // [time, openCount]
const openCount = () => [...sockets.values()].filter(s => s.url.includes('hyperliquid') && s.open && !s.closed).length;
const liveSockets = () => [...sockets.values()].filter(s => !s.closed && s.url.includes('hyperliquid'));
let maxOpen = 0;
on('Network.webSocketCreated', p => { sockets.set(p.requestId, { id: p.requestId, url: p.url, created: stamp(), open: false, closed: false, subs: new Set(), recv: {}, recvAfterClose: 0 }); });
on('Network.webSocketHandshakeResponseReceived', p => { const s = sockets.get(p.requestId); if (s) { s.open = stamp(); maxOpen = Math.max(maxOpen, openCount()); openTimeline.push([stamp(), openCount()]); } });
on('Network.webSocketClosed', p => { const s = sockets.get(p.requestId); if (s) { s.closed = stamp(); openTimeline.push([stamp(), openCount()]); } });
on('Network.webSocketFrameSent', p => {
  const s = sockets.get(p.requestId); if (!s) return;
  let m; try { m = JSON.parse(p.response.payloadData); } catch { return; }
  if (!m.subscription) return;
  const key = `${m.subscription.type}:${m.subscription.coin}`;
  m.method === 'subscribe' ? s.subs.add(key) : s.subs.delete(key);
});
on('Network.webSocketFrameReceived', p => {
  const s = sockets.get(p.requestId); if (!s) return;
  let m; try { m = JSON.parse(p.response.payloadData); } catch { return; }
  const coin = m.data?.coin ?? m.data?.[0]?.coin ?? m.data?.s ?? '';
  const key = `${m.channel}:${coin}`; s.recv[key] = (s.recv[key] ?? 0) + 1;
  if (s.closed) s.recvAfterClose++;
});

// ---- REST blocking via Fetch domain -------------------------------------
const block = { meta: false, candleSnapshot: false };
const restCalls = { meta: 0, candleSnapshot: 0, metaBlocked: 0, candleBlocked: 0 };
on('Fetch.requestPaused', async p => {
  const body = p.request.postData ?? '';
  const type = body.includes('candleSnapshot') ? 'candleSnapshot' : body.includes('"meta"') ? 'meta' : null;
  if (type) restCalls[type]++;
  if (type && block[type]) { restCalls[type === 'meta' ? 'metaBlocked' : 'candleBlocked']++; await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' }).catch(() => {}); }
  else await send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
});

const consoleIssues = [];
on('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'warning') consoleIssues.push({ at: stamp(), type: p.type, text: p.args.map(x => x.value ?? x.description).join(' ').slice(0, 200) }); });
on('Runtime.exceptionThrown', p => consoleIssues.push({ at: stamp(), type: 'exception', text: (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 200) }));
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*hyperliquid-testnet.xyz/info*', requestStage: 'Request' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
// App-level truth: record every app WebSocket and when the app itself calls close().
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__ws = []; window.__maxUnclosedAtCreate = 0; const Native = window.WebSocket;
  window.WebSocket = class extends Native { constructor(url, protocols) { super(url, protocols);
    if (!String(url).includes('hyperliquid')) return;
    const unclosed = window.__ws.filter(r => r.closedByApp === null).length;
    window.__maxUnclosedAtCreate = Math.max(window.__maxUnclosedAtCreate, unclosed);
    const rec = { created: Math.round(performance.now()), closedByApp: null }; window.__ws.push(rec);
    const close = this.close.bind(this); this.close = (...a) => { if (rec.closedByApp === null) rec.closedByApp = Math.round(performance.now()); return close(...a); }; } };` });
const setOffline = offline => send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

// ---- Page helpers --------------------------------------------------------
const installWatcher = () => evaluate(`(async () => {
  // Import the exact module URL the app loaded (Vite adds ?t= after hot updates), so this is the app's store.
  const url = performance.getEntriesByType('resource').map(e => e.name).find(n => new URL(n).pathname === '/src/data/store.ts');
  if (!url) throw new Error('store module not found; is this the Vite dev server?');
  const { marketStore } = await import(url);
  window.__store = marketStore;
  window.__violations = [];
  const band = (coin, px) => coin === 'BTC' ? px > 20000 : coin === 'ETH' ? px > 300 && px < 20000 : true;
  marketStore.subscribe((s, prev) => {
    const bad = (what, px) => { if (px && !band(s.coin, px)) window.__violations.push({ at: Date.now(), coin: s.coin, what, px }); };
    if (s.book !== prev.book && s.book) bad('book', s.book.bids[0]?.price);
    if (s.trades !== prev.trades && s.trades.length) bad('trade', s.trades[0].price);
    if (s.candles !== prev.candles && s.candles.length) bad('candle', s.candles.at(-1).close);
  });
  return true;
})()`);
const state = () => evaluate(`(() => { const s = window.__store.getState(); return { coin: s.coin, connection: s.connection,
  book: !!s.book, mid: s.book?.bids[0] ? Math.round((s.book.bids[0].price + s.book.asks[0].price) / 2) : null,
  candles: s.candles.length, lastClose: s.candles.at(-1)?.close ?? null, trades: s.trades.length,
  historyLoading: s.historyLoading, historyError: s.historyError, reconnects: s.reconnects, feedError: s.feedError,
  online: navigator.onLine }; })()`);
const ui = () => evaluate(`(() => ({
  status: document.querySelector('.connection')?.textContent,
  staleLabels: [...document.querySelectorAll('body *')].filter(e => !e.children.length && /stale/i.test(e.textContent)).map(e => e.textContent.trim()),
  chartEmpty: document.querySelector('.chart-empty')?.textContent ?? null,
  caption: document.querySelector('.chart-caption span')?.textContent,
  marketError: document.querySelector('.market-error')?.textContent ?? null,
  bookHeader: document.querySelector('.book-columns')?.textContent,
  headings: [...document.querySelectorAll('.panel-heading h2')].map(h => h.textContent.replace(/\\s+/g, ' ').trim()),
  notice: document.querySelector('.chart-notice span')?.textContent ?? null,
  noticeRetry: !!document.querySelector('.chart-notice button'),
  scrollWidth: document.documentElement.scrollWidth, innerWidth,
  overlayVisible: (() => { const e = document.querySelector('.chart-empty'); if (!e) return null; const r = e.getBoundingClientRect(); e.style.pointerEvents = 'auto'; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); e.style.pointerEvents = ''; return hit === e || e.contains(hit); })(),
  errorOverlaps: (() => { const e = document.querySelector('.market-error'); if (!e) return null; const a = e.getBoundingClientRect();
    return [...document.querySelectorAll('.panel')].some(p => { const b = p.getBoundingClientRect(); return !(a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left); }); })(),
  overflowing: [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => e.className || e.tagName).slice(0, 5),
}))()`);
const shot = async name => {
  const { cssContentSize } = await send('Page.getLayoutMetrics');
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: await evaluate('innerWidth'), height: Math.ceil(cssContentSize.height), scale: 1 } });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  const u = await ui();
  check(`layout ${name}: no horizontal overflow`, u.scrollWidth <= u.innerWidth && !u.overflowing.length, `scrollWidth ${u.scrollWidth}, overflowing ${JSON.stringify(u.overflowing)}`);
  if (u.overlayVisible !== null) check(`layout ${name}: chart empty-state text is on top`, u.overlayVisible, u.chartEmpty);
  if (u.errorOverlaps !== null) check(`layout ${name}: error banner overlaps no panel`, !u.errorOverlaps);
  return u;
};
const selectMarket = coin => evaluate(`(() => { const el = document.querySelector('#market');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(coin)});
  el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
// Mirrors isFresh in src/data/store.ts: book and trades both delivered on the current live connection.
const bookAndTradesFresh = () => evaluate(`(() => { const s = window.__store.getState();
  const fresh = at => s.connection === 'live' && at !== null && s.connectedAt !== null && at >= s.connectedAt;
  return fresh(s.bookAt) && fresh(s.tradesAt); })()`);
const liveClaimMatches = async u => /Order book and trades are live/.test(u.notice ?? '') === await bookAndTradesFresh();
const subsOfLive = () => liveSockets().map(s => [...s.subs].sort().join(','));
const liveReady = coin => waitFor(`${coin} live with data`, `(() => { const s = window.__store?.getState(); return s && s.coin === '${coin}' && s.connection === 'live' && !!s.book && s.candles.length > 0 && !s.historyLoading; })()`, 25_000);
const expectHeadings = async (label, coin) => {
  const u = await ui();
  check(`${label}: every panel heading names ${coin}`, u.headings.length === 3 && u.headings.every(h => h.includes(`/ ${coin}`)), JSON.stringify(u.headings));
};
const expectSingleSocketFor = (label, coin) => {
  const live = liveSockets();
  const expected = [`candle:${coin}`, `l2Book:${coin}`, `trades:${coin}`].join(',');
  check(`${label}: exactly one open socket`, live.length === 1, `open sockets ${live.length}`);
  check(`${label}: its subscriptions are ${coin} only`, live.length === 1 && [...live[0].subs].sort().join(',') === expected, JSON.stringify(subsOfLive()));
};

try {
  // 1. Markets REST failure on first load, then Retry --------------------
  log('scenario 1: markets REST failure and Retry (phone)');
  block.meta = true;
  await send('Page.navigate', { url: APP });
  await waitFor('market error', `!!document.querySelector('.market-error')`, 20_000);
  let u = await shot('01-markets-error');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await shot('01b-markets-error-desktop');
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  check('markets failure: status and chart say waiting for markets, not connecting or loading', u.status === 'Waiting for markets' && u.chartEmpty === 'Waiting for market list', JSON.stringify({ status: u.status, chart: u.chartEmpty }));
  check('markets failure shows an inline error with Retry', !!u.marketError && u.marketError.includes('Retry'), u.marketError);
  check('no WebSocket opened without a market', liveSockets().length === 0, `sockets ${sockets.size}`);
  block.meta = false;
  await evaluate(`document.querySelector('.market-error button').click(), true`);
  await waitFor('markets loaded', `document.querySelector('#market')?.value === 'BTC'`);
  await installWatcher();
  check('Retry loads markets and starts BTC', await liveReady('BTC'), JSON.stringify(await state()));
  await shot('02-btc-live');
  expectSingleSocketFor('after initial load', 'BTC');
  await expectHeadings('after initial load', 'BTC');

  // 2. Rapid BTC -> ETH -> BTC -------------------------------------------
  log('scenario 2: rapid BTC -> ETH -> BTC');
  const before = sockets.size;
  await selectMarket('ETH'); await sleep(150); await selectMarket('BTC');
  check('rapid switch: back on BTC and live', await liveReady('BTC'), JSON.stringify(await state()));
  await sleep(4000);
  expectSingleSocketFor('after rapid switch', 'BTC');
  log('sockets created during rapid switch:', sockets.size - before);
  let s = await state();
  check('rapid switch: BTC mid price in BTC range', s.mid > 20000, `mid ${s.mid}`);

  // 3. Slow BTC -> ETH -> BTC --------------------------------------------
  log('scenario 3: settled BTC -> ETH -> BTC');
  await selectMarket('ETH');
  check('switch to ETH reaches live with data', await liveReady('ETH'), JSON.stringify(await state()));
  expectSingleSocketFor('on ETH', 'ETH');
  await expectHeadings('on ETH', 'ETH');
  s = await state(); check('ETH mid price in ETH range', s.mid > 300 && s.mid < 20000, `mid ${s.mid}`);
  await shot('03-eth-live');
  await selectMarket('BTC');
  check('switch back to BTC reaches live with data', await liveReady('BTC'), JSON.stringify(await state()));
  await sleep(4000);
  expectSingleSocketFor('back on BTC', 'BTC');
  await expectHeadings('back on BTC', 'BTC');

  // 4. Candle history blocked: automatic retry, then manual Retry -------
  log('scenario 4: candle history blocked, switch to ETH');
  block.candleSnapshot = true;
  const blockedBefore = restCalls.candleBlocked;
  const blocked = () => restCalls.candleBlocked - blockedBefore;
  await selectMarket('ETH');
  await waitFor('history error', `!!window.__store.getState().historyError`, 20_000);
  u = await ui(); s = await state();
  check('history failure: chart says it retries automatically; "book and trades are live" only if both are fresh',
    /Retrying automatically in 5 seconds/.test(u.notice ?? '') && await liveClaimMatches(u) && !u.noticeRetry, JSON.stringify({ notice: u.notice, retry: u.noticeRetry, fresh: await bookAndTradesFresh() }));
  await shot('04-history-failed-first');
  await waitFor('automatic retry failure', `/Automatic retry failed/.test(window.__store.getState().historyError ?? '')`, 12_000);
  u = await ui();
  check('after one automatic retry the chart offers Retry', blocked() === 2 && u.noticeRetry && await liveClaimMatches(u), `blocked requests ${blocked()}, ${JSON.stringify({ notice: u.notice, retry: u.noticeRetry, fresh: await bookAndTradesFresh() })}`);
  await sleep(8000);
  check('no further history requests without Retry', blocked() === 2, `blocked requests ${blocked()}`);
  s = await state();
  check('book and trades still live during history failure', s.connection === 'live' && s.book && s.mid > 300 && s.mid < 20000, JSON.stringify(s));
  u = await shot('05-history-failed-retry');
  log('history-failed UI:', JSON.stringify({ chartEmpty: u.chartEmpty, notice: u.notice, caption: u.caption, status: u.status }));
  expectSingleSocketFor('during history failure', 'ETH');
  await evaluate(`document.querySelector('.chart-notice button').click(), true`);
  await waitFor('manual retry failure', `!!window.__store.getState().historyRetry`, 12_000);
  await sleep(500); u = await ui();
  check('a failed manual Retry offers Retry again', blocked() === 3 && u.noticeRetry, `blocked requests ${blocked()}, retry ${u.noticeRetry}`);
  block.candleSnapshot = false;
  await evaluate(`document.querySelector('.chart-notice button').click(), true`);
  await waitFor('history loaded', `window.__store.getState().candles.length > 1 && !window.__store.getState().historyError`, 15_000);
  s = await state(); u = await ui();
  check('a successful manual Retry loads history and clears the notice', s.candles > 1 && !s.historyError && u.notice === null, JSON.stringify({ candles: s.candles, err: s.historyError, notice: u.notice }));
  await shot('05b-history-recovered');

  // 5. Network offline, then restored ------------------------------------
  log('scenario 5: network offline, then restored');
  const socketsBeforeOffline = sockets.size;
  await setOffline(true);
  await waitFor('offline state', `window.__store.getState().connection === 'offline'`, 10_000);
  s = await state(); u = await ui();
  check('offline: connection state offline and navigator.onLine false', s.connection === 'offline' && s.online === false, JSON.stringify({ connection: s.connection, online: s.online }));
  check('offline: badge says recovery is automatic', u.status === 'Offline · will reconnect', u.status);
  check('offline: every panel with data says Stale · offline; chart and book show the last update time',
    u.staleLabels.length >= 4 && u.staleLabels.every(l => l.includes('Stale · offline'))
    && u.staleLabels.filter(l => /last update \d\d:\d\d:\d\d UTC/.test(l)).length >= 2, JSON.stringify(u.staleLabels));
  const offlineLabels = u.staleLabels;
  await expectHeadings('offline', 'ETH');
  await shot('06-offline');
  await sleep(20_000);
  const attemptsOffline = sockets.size - socketsBeforeOffline;
  s = await state();
  const appUnclosed = await evaluate(`window.__ws.filter(r => r.closedByApp === null).length`);
  const handshakenOffline = [...sockets.values()].slice(socketsBeforeOffline).filter(x => x.open).length;
  check('offline: stays offline; app closed its socket; no retry connected', s.connection === 'offline' && appUnclosed <= 1 && handshakenOffline === 0, `state ${s.connection}, app-unclosed ${appUnclosed}, retries ${attemptsOffline}, retries connected ${handshakenOffline}`);
  log('offline retry sockets created at:', [...sockets.values()].slice(socketsBeforeOffline).map(x => x.created.trim()).join(', '));
  u = await ui();
  check('offline: last update time does not advance while offline', JSON.stringify(u.staleLabels) === JSON.stringify(offlineLabels), JSON.stringify(u.staleLabels.slice(0, 1)));
  await shot('07-offline-after-20s');
  await setOffline(false);
  check('restore: back to live with history', await liveReady('ETH'), JSON.stringify(await state()));
  s = await state(); u = await ui();
  check('restore: no stale labels or chart notice', u.staleLabels.length === 0 && u.notice === null && u.status === 'Connected', JSON.stringify({ stale: u.staleLabels, notice: u.notice, status: u.status }));
  await sleep(4000);
  expectSingleSocketFor('after restore', 'ETH');
  await shot('08-restored');

  // 6. Offline mid-switch: go offline on ETH, switch to BTC, restore --------
  log('scenario 6: switch market while offline');
  await setOffline(true);
  await waitFor('offline state', `window.__store.getState().connection === 'offline'`, 10_000);
  await selectMarket('BTC');
  await sleep(3000);
  s = await state(); u = await ui();
  check('offline switch: no stale labels on empty panels', u.staleLabels.length === 0, JSON.stringify(u.staleLabels));
  log('offline switch UI:', JSON.stringify({ status: u.status, chartEmpty: u.chartEmpty, connection: s.connection }));
  await shot('09-offline-switch');
  await setOffline(false);
  check('offline switch: restore reaches BTC live', await liveReady('BTC'), JSON.stringify(await state()));
  await sleep(4000);
  expectSingleSocketFor('after offline switch restore', 'BTC');
  await expectHeadings('after offline switch restore', 'BTC');

  // Global checks ---------------------------------------------------------
  const violations = await evaluate('window.__violations');
  check('no store update with a price from the other market', violations.length === 0, JSON.stringify(violations.slice(0, 5)));
  const maxUnclosed = await evaluate('window.__maxUnclosedAtCreate');
  check('app never creates a socket while another is still unclosed', maxUnclosed === 0, `max unclosed at create ${maxUnclosed}`);
  log('network-level max concurrently open app sockets (includes close handshake lag):', maxOpen);
  const afterClose = [...sockets.values()].reduce((n, x) => n + x.recvAfterClose, 0);
  check('no frames received on closed sockets', afterClose === 0, `frames ${afterClose}`);
  check('no uncaught exceptions', !consoleIssues.some(i => i.type === 'exception'), JSON.stringify(consoleIssues.filter(i => i.type === 'exception')));
  log('console errors/warnings:', JSON.stringify(consoleIssues));
} catch (error) {
  check('script completed', false, String(error?.stack ?? error));
} finally {
  const inventory = [...sockets.values()].map(s => ({ created: s.created, open: s.open, closed: s.closed, subs: [...s.subs], recv: s.recv }));
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ chrome: version?.Browser, results, consoleIssues, restCalls, maxOpen, openTimeline, sockets: inventory }, null, 2));
  const failed = results.filter(r => !r.pass).length;
  log(`${results.length - failed}/${results.length} checks passed; sockets created ${sockets.size}; REST ${JSON.stringify(restCalls)}`);
  ws.close(); chrome.kill();
  process.exit(failed ? 1 : 0);
}
