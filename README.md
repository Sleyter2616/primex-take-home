# Hyperliquid testnet market terminal

A single-page, read-only perpetuals terminal with a live order book, recent trades, and a one-minute candlestick chart. Market discovery and every data request use **testnet**. No credentials or wallet are required.

## Run

Requires Node.js 22.12 or newer. From this directory:

```sh
npm ci && npm run dev
```

Open the URL printed by Vite (normally http://127.0.0.1:5173).

```sh
npm test           # deterministic parsing, buffering, lifecycle and stale-label tests
npm run typecheck  # TypeScript only
npm run build      # TypeScript checks and production build
npm run preview
```

Open `/?profile=1` on the dev server to show the render profiler (development builds only; it is compiled out of `npm run build`).

Browser lifecycle checks (needs `npm run dev` running and a local Google Chrome; uses live testnet):

```sh
node scripts/verify-lifecycle.mjs http://127.0.0.1:5173/
```

Synthetic load harness (generated data, not Hyperliquid; see Synthetic load below):

```sh
npm run build && npm run preview
```

```sh
node scripts/load-harness.mjs http://127.0.0.1:4173/ --throttle 4
```

## Scope

- Active perpetuals from testnet metadata, with BTC, ETH and SOL listed first.
- Up to 20 bid and ask levels, price, base-asset size, cumulative size, and proportional depth bars. Asks are displayed above bids; accumulation starts at the best price on each side.
- Latest 50 unique trades, newest first, with aggressor side and UTC time.
- One-minute candles, seeded with approximately 200 minutes of history and updated live. At most 300 candles are retained.
- Loading, empty, REST failure, connection and stale-data states; automatic reconnect and resubscription. See Failure states below.

## Failure states

Each failure answers four questions for a trader: which market, whether the numbers are retained, what failed, and whether recovery is automatic.

| Situation | What the screen says | Recovery |
|---|---|---|
| Market list request fails | `Could not load the market list. This does not retry automatically.` with **Retry**; badge `Waiting for markets`; chart `Waiting for market list` | Manual: Retry |
| Socket drops | Badge `Reconnecting automatically`; panels with data say `Stale · reconnecting`, and the chart caption and order book footer add `last update HH:MM:SS UTC` | Automatic, backoff capped at 15 s |
| Socket reconnected, a channel has not sent anything yet | That panel keeps its retained data and says `Stale · waiting for update` until its first message on the new socket | Automatic |
| Browser offline | Badge `Offline · will reconnect`; same stale labels with `Stale · offline` | Automatic when the browser is back online |
| Candle history fails, socket live | Notice over the chart: `Candle history unavailable. Retrying automatically in 5 seconds.` It adds `Order book and trades are live.` only when both have delivered on the current connection | Automatic once |
| Automatic history retry also fails | `Candle history unavailable. Automatic retry failed.` with **Retry**, plus `Order book and trades are live.` under the same condition as above | Manual: Retry (repeatable) |
| History failed and the socket then drops | `Candle history unavailable. It reloads automatically after reconnecting.` | Automatic on reconnect |

Every panel heading names the coin (`Price chart / ETH`, `Recent trades / ETH`, `Order book / ETH`). A market switch clears the previous market's data at once, so numbers are never shown under another market's name. A panel is fresh only when its data arrived on the current live connection; otherwise, if it is showing data, it is labelled stale. Connections are numbered by a counter that only increases, so freshness does not depend on the system clock; an empty history response refreshes nothing. Before its first data arrives it shows loading text instead. Each panel's last-update time is the wall-clock time its own data last arrived (book, trades, candles separately), so it does not change while disconnected.

## Architecture and performance

```text
testnet REST: meta --------------------------> market selector
testnet REST: candleSnapshot -----+
                                 v
testnet WebSocket -> validation -> frame buffer -> Zustand store
                     l2Book         latest book     |-> order book
                     trades         bounded merge   |-> trades tape
                     candle         bounded merge   +-> chart API
```

`src/data/api.ts` owns the fixed testnet endpoints and REST requests. `types.ts` validates incoming fields and implements ordering, deduplication, depth accumulation and bounded merges. `feed.ts` owns sockets, timers, history requests and the animation-frame buffer. `store.ts` holds the Zustand store and the `staleLabel` rule. Views live in `src/ui/`. `src/perf/metrics.ts` holds the development-only event counters; it has no React import, so the data layer can count socket messages without depending on the UI.

The book feed provides complete snapshots, so only the newest snapshot within a frame needs to reach the screen. Trades are accumulated and deduplicated before publishing, preserving the newest 50 executions. Candles merge by opening timestamp. Normal feed updates publish at most once per animation frame; reconnect flushes buffered data immediately, and rejected-ID diagnostics update separately; individual React panels select their own slices. Book rows compare their displayed values, and existing trade rows retain stable keys. These boundaries isolate book ticks from the shell and the chart React component; see Measured render counts below.

The chart subscribes directly to the store. Changed candles use the chart library's imperative `update` API. Initial history, refreshed history and movement of the bounded window use `setData`. The chart instance survives market changes and is removed on component teardown.

Each selected market owns one socket with three subscriptions. A market switch tears down that session and starts another. This costs an extra handshake but simplifies ownership within the exercise's time budget. A generation guard, selected-market check and abort controller prevent obsolete socket or REST callbacks from contaminating the new market, including BTC → ETH → BTC races. Strict Mode cleanup follows the same path.

Reconnect retries are **unbounded in attempt count**, with exponential delay plus jitter capped at **15 seconds total**. Each successful connection resubscribes and refreshes the last **200 minutes** of candle history (`candleSnapshot` from now minus 200 minutes). A gap longer than 200 minutes leaves a hole in the chart. Trades missed while disconnected are **not replayed**: the tape shows only what the new subscription sends. An offline event marks the feed offline and reconnects immediately; an online event resets backoff and connects immediately. Both event listeners are removed on disposal. Buffered current-generation trades and candles are published before reconnect clears the buffers, so an interruption between frames does not discard them. Heartbeats run every 15 seconds; a silent connection is detected on a heartbeat check after 35 seconds without a message. Socket establishment times out after 10 seconds and history after 12 seconds. Retained book/trades are marked stale while reconnecting. During a history request, live candles are preserved and overlaid on the REST response so late history cannot roll back those updates.

Failed candle history gets one independent retry after five seconds while the same socket generation remains live. If that also fails while the socket is live, the chart offers a manual Retry; if the socket drops, the next connection reloads history. Reconnect and disposal cancel the automatic retry and withdraw the Retry control. Trades sort newest timestamp first, then numeric `tid` descending for equal timestamps; the tie-break is deterministic, not a claim that IDs encode execution order. Invalid safe-integer `tid` values are counted in `rejectedTradeIds` for the selected feed and logged once per affected batch without payload contents.

## Measured render counts

Method (2026-09-24, about 01:20 UTC, current code): `npm run dev`, page opened at `/?profile=1` in headless Chrome 153 at 1024 x 768, driven over the Chrome DevTools Protocol (`visibleAtStart: true`, `requestAnimationFrame` measured at 62 callbacks per second just before each window). React Strict Mode on. Each panel is wrapped in a React `<Profiler>`; its `onRender` callback increments a counter once per **commit** of that panel. Strict Mode double rendering does not add commits. The feed and chart adapter count WebSocket book messages, trade batches, and chart `update` / `setData` calls in the same window. After history loaded, the "Measure 60 seconds" button recorded one 60-second window per coin with no user interaction. The raw JSON is printed to the console as `HL_PROFILE_RESULT` and below the button.

| Counter (60 s) | BTC | ETH |
|---|---|---|
| `bookMessages` | 12 | 11 |
| `OrderBook` commits | 12 | 11 |
| `MarketSummary` commits | 4 | 3 |
| `tradeBatches` | 0 | 5 |
| `TradesTape` commits | 0 | 5 |
| `seriesUpdate` (chart API) | 0 | 5 |
| `seriesSetData` (chart API) | 0 | 0 |
| `PriceChart` commits | 0 | 0 |
| `Header`, `ConnectionStatus`, `MarketSelector` commits | 0 | 0 |

What this shows: each panel committed only when its own slice changed. The order book committed once per book message and the tape once per trade batch. The summary committed only when best bid, best ask or mid moved. Live candles reached the chart through `update` without a React commit of `PriceChart`. The header, status and selector did not commit at all. Three earlier runs on 2026-09-23 and 2026-09-24, on earlier versions of the freshness code, showed the same pattern.

What this does not show:
- Throughput. Testnet was quiet (about 11 book snapshots a minute per coin). A raw WebSocket subscribed to BTC and ETH for 30 seconds on 2026-09-23 received 7 book snapshots per coin, so the low counts reflect the feed, not dropped messages. Frame coalescing under a high message rate is covered only by the unit tests.
- Timing. These are commit counts from a development build, not frame times or durations. No frame-rate claim is made.

Raw results:

```json
{"coin":"BTC","visibleAtStart":true,"visibilityChanges":0,"windowMs":60000,"completedAfterMs":60002,"Header":0,"ConnectionStatus":0,"MarketSelector":0,"MarketSummary":4,"PriceChart":0,"TradesTape":0,"OrderBook":12,"bookMessages":12,"tradeBatches":0,"seriesUpdate":0,"seriesSetData":0}
{"coin":"ETH","visibleAtStart":true,"visibilityChanges":0,"windowMs":60000,"completedAfterMs":60001,"Header":0,"ConnectionStatus":0,"MarketSelector":0,"MarketSummary":3,"PriceChart":0,"TradesTape":5,"OrderBook":11,"bookMessages":11,"tradeBatches":5,"seriesUpdate":5,"seriesSetData":0}
```

## Synthetic load

**All data in this section is synthetic: generated messages, not Hyperliquid data.** The quiet-feed counts above show render isolation; they say nothing about a firehose. Two harnesses push bursts through the same feed-processing path. Neither adds code to the application.

**1. Unit bursts (`src/data/feed.load.test.ts`, part of `npm test`).** The real `MarketFeed` receives generated messages from a fake socket with a seeded random generator:
- 5,000 shuffled book snapshots between two frames: only the newest is published, in one store update.
- 400 shuffled trade batches (over 5,000 unique trades, with duplicates and equal timestamps) spanning several frames: the store holds exactly the newest 50 unique trades, and the pending buffer never exceeds 50.
- 20,000 candle revisions across 1,000 minutes while history is loading: the pending and during-history candle buffers never exceed 300, and the store holds the newest 300 minutes with their latest revisions.
- 100 frames of mixed load: exactly one store update per frame.

**2. Browser harness (`scripts/load-harness.mjs`).** Headless Chrome replaces `WebSocket` and the two REST calls inside the test page only, and shows a banner reading `SYNTHETIC LOAD TEST: generated data, not Hyperliquid`. The unmodified app (parsing, frame buffer, store, React panels, chart adapter) then receives, after a 3 s warm-up that fills the panels:
- 30 s at 200 book snapshots, 100 trade batches (10 trades each, about 20% repeated) and 50 candle updates per second, which is roughly 1,000 times the book rate observed on testnet;
- then one burst of 3,000 book snapshots, 1,500 trade batches and 500 candle updates in a single task.

The generator runs on the page's main thread, so its own work (building and serializing messages) is included in the measured cost. A key press is sent every 500 ms and measured with the Event Timing API. Before each run the long-task probe must report a planted 60 ms task; this matters because work started from a DevTools `evaluate` call is not reported as a long task, so the burst is scheduled as an ordinary page task. Pass limits were fixed before running.

Runs on 2026-09-24 about 02:30 UTC: Apple M5 Pro, headless Chrome 153, 1280 x 800. The dev run uses `?profile=1` for React commit counts; the production runs use `npm run preview`.

| Result (synthetic) | Dev | Production | Production, CPU 4x slower |
|---|---|---|---|
| Messages sent (book / trade batches / candles) | 9,714 / 4,857 / 2,178 | 9,712 / 4,856 / 2,178 | 9,838 / 4,919 / 2,209 |
| Newest book on screen after load and after burst | yes / yes | yes / yes | yes / yes |
| Trade rows equal the newest 50 unique trades | yes / yes | yes / yes | yes / yes |
| DOM nodes (after warm-up, after load, after burst) | 1,441 / 1,061 / 1,061 | 1,524 / 1,054 / 1,054 | 1,464 / 1,054 / 1,054 |
| JS heap after GC, MB (same points) | 11.2 / 10.5 / 10.4 | 4.3 / 4.5 / 4.5 | 4.4 / 4.5 / 4.5 |
| Frame interval p50 / p95 / max, ms | 16.7 / 16.7 / 16.8 | 16.7 / 16.7 / 16.8 | 16.7 / 16.7 / 16.8 |
| Long tasks during sustained load | 0 | 0 | 0 |
| Timer lag p95 / max, ms | 4.2 / 12.8 | 4.7 / 13.2 | 18.5 / 35.9 |
| Longest key press (Event Timing), ms | 32 | 32 | 32 |
| Burst task / newest data on screen after, ms | 43 / 15 | 44 / 7 | 155 / 26 |
| `PriceChart` commits / chart `update` calls | 0 / 1,508 | not instrumented | not instrumented |
| `OrderBook` commits / book messages | 1,825 / 9,114 | not instrumented | not instrumented |
| Header, status, selector commits | 0 | not instrumented | not instrumented |

What this supports, for this synthetic load on this machine: the newest book and the newest 50 unique trades reach the screen during and after bursts; buffers, DOM size and heap stay flat; the chart keeps updating through the chart API with no React commits of the chart component; order-book commits are bounded by frames (about 60 per second), not by messages (about 200 per second during sustained load, plus the 3,000-message burst); the page kept 60 frames per second with no long tasks, and at 4x CPU throttling the only long task was the deliberate 5,000-message burst (154 ms), after which the newest data was on screen within 26 ms.

What it does not support: real-market message shapes and rates (the data is generated and uniform), slower phones or GPUs, or behavior beyond 30 s. Headless Chrome paces frames at 60 Hz regardless of CPU throttling, so frame intervals cannot show dropped frames caused by painting; long tasks, timer lag and input timing are the better signals here. The first attempts found three harness errors, not app errors, and they were fixed before these numbers: the DOM and heap baseline was taken before the panels were filled, the burst ran where the long-task probe could not see it, and the harness's own trade bookkeeping grew the heap.

## Libraries

- **React + TypeScript:** typed components and explicit data contracts.
- **Vite:** a small client-only development/build setup; this UI needs no application server.
- **Zustand:** a vanilla store usable both by React selectors and the imperative chart adapter.
- **TradingView Lightweight Charts:** performant candlesticks, zooming and panning. Attribution is retained in the UI.
- **Vitest:** deterministic socket/timer tests without depending on testnet activity.

## Verification

The automated suite (42 tests, including the four synthetic burst tests described under Synthetic load) covers per-panel freshness (retained data stays stale after a reconnect until its channel delivers, including a reconnect in the same millisecond, a clock stepping backwards, and an empty history response), the stale-label rule and its last-update time, manual history retry after the automatic retry fails, offline/online events, the exact backoff cap including jitter, one-shot history retry, rejection diagnostics, a real captured trades fixture, reconnect flushing, snapshot ordering and depth, malformed inputs, trade deduplication and caps, both candle payload shapes, history/live merging, frame coalescing, unrelated slice identity, late-market callbacks, reconnect/resubscribe, heartbeat timeout and teardown.

Scripted lifecycle checks (`scripts/verify-lifecycle.mjs`), last run 2026-09-24 about 01:15 UTC against live testnet and the dev server. Headless Chrome 153 with a fresh profile, phone viewport 375 x 812 throughout plus a 1280 x 800 capture of the markets error, driven over the Chrome DevTools Protocol. The script fails only the chosen REST request type (`meta` or `candleSnapshot`) with `Fetch.failRequest`, cuts the network with `Network.emulateNetworkConditions` (real offline: `navigator.onLine` false, new sockets fail), and logs every WebSocket, subscribe and unsubscribe frame and received channel. It wraps `WebSocket` in the page to record when the app itself calls `close()`, and subscribes to the app's store to flag any book, trade or candle price that does not fit the selected coin (BTC above 20,000; ETH between 300 and 20,000). Every capture is checked for horizontal overflow, a chart empty-state text that is actually on top, and an error row that overlaps no panel. Result: 65 of 65 checks passed. Screenshots and `result.json` are written to `$TMPDIR/hl-verify`.

| Scenario | Observed |
|---|---|
| Markets REST failure on first load | Error row with Retry in its own row (no overlap at either width); badge `Waiting for markets`; chart `Waiting for market list`; no socket opened. Retry loads markets and BTC goes live. |
| Rapid BTC to ETH to BTC (150 ms apart) | 2 sockets created; the ETH one closed before its handshake. One open socket afterwards, subscribed to `l2Book`, `trades` and `candle` for BTC only; every heading says BTC. |
| Settled BTC to ETH to BTC | Each switch unsubscribes and closes the old socket, then one new socket subscribes only to the new coin. |
| Candle history blocked, switch to ETH | Notice says it retries automatically, and says book and trades are live exactly when both have delivered on the current connection; exactly one retry about 5 s later; then Retry appears and no further requests are made without it. A Retry while still blocked fails and offers Retry again; a Retry after unblocking loads 200 candles and clears the notice. |
| Network offline | State `offline`; badge `Offline · will reconnect`; all four panels with data say `Stale · offline`, chart and book with `last update HH:MM:SS UTC`, and that time does not advance; the app closes its socket at once; retry sockets at +1.2, +3.7, +7.9 and +16.3 s all failed, none connected. |
| Network restored | One immediate reconnect; history reloads; stale labels and notice clear; one socket with ETH subscriptions only. |
| Switch to BTC while offline, then restore | No stale labels on the emptied panels while offline; restore reaches BTC live with one BTC-only socket. |
| Whole run | No store update carried a price from the other market; the app never created a socket while another was unclosed; no frames on closed sockets; no uncaught exceptions or console errors. |

Chrome reports a closed socket only after its close handshake finishes, so under offline emulation a socket the app has already closed still appears open until the network returns; the app-level `close()` record is the source of truth there.

Bugs these runs found and fixed: the markets error was absolutely positioned over the chart heading; the chart's loading and waiting text sat under the chart canvases (Lightweight Charts uses z-index 1 to 3) and was invisible at every width; with no market list the badge said `Connecting`; after the automatic history retry failed, the chart could only recover on a reconnect that a healthy socket never triggers; at phone width the long stale labels wrapped the summary and trades headers. A Codex review (gpt-6-sol) then found that a reconnect cleared stale labels before fresh data arrived, and that the chart notice could call the book and trades live before either had delivered; both are fixed by per-panel freshness. A second review found that comparing timestamps was fragile (same-millisecond reconnect, clock steps) and that an empty history response marked retained candles fresh; freshness now uses a connection counter and ignores empty history.

Earlier manual checks in the desktop app's built-in browser covered 768 and 1280 widths on live data. Neither these checks nor the unit tests replace a production soak test.

## Trade-offs

Each entry: the decision, the alternative, and why.

- **One socket per selected market.** Alternative: one shared socket, unsubscribing and resubscribing on market change. A fresh socket per market makes ownership simple: disposal closes everything that market started, and a generation check drops late callbacks. Cost: one extra handshake per switch.
- **Publish at most once per animation frame.** Alternative: write every message to the store. Book messages are full snapshots, so only the newest one in a frame is worth rendering; trades and candles are merged in the buffer. This bounds React work to the display rate regardless of message rate.
- **Vanilla Zustand store read by both React and the chart.** Alternative: React context or a React-only store. The chart subscribes outside React and calls the chart API directly, so live candles do not re-render the chart component (measured: 0 `PriceChart` commits).
- **`update` for changed candles, `setData` only for history, market change or window movement.** Alternative: `setData` on every change. `update` touches one bar; `setData` rebuilds the series.
- **Unbounded reconnect attempts, delay capped at 15 seconds including jitter.** Alternative: give up after N attempts. A read-only market screen should recover by itself when the network returns; the cap keeps recovery prompt, and jitter avoids synchronized retries.
- **One automatic history retry, then a manual Retry.** Alternatives: retry until it succeeds, or wait for the next reconnect. One retry covers a transient REST failure without hammering the endpoint. Waiting for a reconnect was the original design, but a healthy socket never reconnects, so the chart could stay empty indefinitely; Retry is the only control added, and it appears only in that state.
- **Freshness per panel, keyed to a connection counter.** Alternatives: treat everything as fresh once the socket is live, or compare receipt times with the socket-open time. The socket reopens before any channel has re-sent data, so the first would briefly present retained numbers as current. The second was the first fix, and a review showed it breaks when a reconnect lands in the same millisecond or the clock steps backwards. Each panel instead records the id of the connection its data arrived on; receipt times are kept for display only.
- **Stale labels carry the last update time where there is room.** Alternative: the time on every label. At phone width the full label wrapped the summary and trades headers, so the chart caption and order book footer show the time and the other two show the short label.
- **Stale means "not live and showing retained data".** Alternative: stale whenever the socket is not live. The simpler rule labelled empty panels as stale during every initial connect and market switch, which was misleading.
- **Trades sorted by time, then numeric `tid` descending.** Alternative: arrival order. The tie-break makes the order deterministic; it is not a claim that IDs encode execution order.
- **JavaScript numbers for prices and sizes.** Alternative: a decimal library. Adequate for display only; order entry would need exact decimals and tick sizes.
- **No list virtualization.** Alternative: virtualize the book and tape. At 40 book rows and 50 trade rows the DOM is small; row components are memoized instead.
- **Development-only profiler behind `?profile=1`.** Alternative: a permanent metrics layer or an external profiler. It records counts with the same code that runs in development, costs nothing in production (compiled out), and the counters live in `src/perf` so the data layer does not import UI code.

## Limitations

- Load behavior is measured with synthetic data only (see Synthetic load): uniform generated messages on one fast machine, 30 s long. Real-market bursts, slower devices and long sessions are not measured.
- Reconnect refills only the last 200 minutes of candles. Trades missed during a disconnect are not replayed or marked as a gap.
- The connection badge reports socket health, not per-channel freshness: a live socket whose book channel stopped would not be flagged.
- Candle revision `n` is not treated as a sequence number; same-minute out-of-order live revisions are not detected.
- `scripts/verify-lifecycle.mjs` depends on live testnet data and a local Chrome, so it is not part of `npm test`. Keyboard access and screen-reader output have no automated check.

## Next steps with more time

In priority order, each with the reason:

1. **Replay real traffic through the load harness.** Record real WebSocket frames (a busy mainnet session, read-only) and feed them through `scripts/load-harness.mjs` instead of generated messages, at 1x, 10x and 50x, for 30 minutes, on a mid-range laptop and a phone as well as this machine. The synthetic harness shows the pipeline holds up; real message shapes, bursts and devices are what would justify or rule out heavier optimizations such as canvas-rendered book rows.
2. **Deterministic browser tests in CI.** Serve the replayed frames and REST fixtures from a local mock server, then run the lifecycle checks with Playwright on every change. Today's script proves the behavior but depends on live testnet. Add keyboard-only navigation and an automated accessibility scan (axe) to the same run.
3. **Mark trade gaps after reconnect.** Insert a visible `Gap: disconnected HH:MM:SS to HH:MM:SS` row in the tape so a trader never reads a continuous tape that is not. Check whether the info endpoint can backfill recent trades before adding any fetching.
4. **Per-channel freshness.** Track the last message time per channel and flag a channel that goes quiet while the socket is live, with thresholds tuned from the replay data.
5. **Candle revision ordering.** Confirm with Hyperliquid whether candle updates carry an ordering guarantee, then reject out-of-order same-minute revisions.
6. **One socket across market switches.** Unsubscribe and resubscribe on the same socket, tracking subscription acknowledgements, to remove a handshake per switch. Worth doing only once the replay tests cover switching races.
7. **Production observability.** Report reconnect counts, history failures, rejected trade IDs and uncaught errors to an error tracker, so failure rates are known rather than inferred.
8. **Before any order entry.** Decimal-safe price and size handling with tick and lot sizes from metadata; JavaScript numbers are fine for display only.

The application deliberately excludes trading, authentication, wallet integration, order forms, alternate candle intervals and persistence.

## References

- [Hyperliquid WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- [Hyperliquid info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Timeouts and heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats)
- [Lightweight Charts documentation](https://tradingview.github.io/lightweight-charts/docs)

Endpoints: `https://api.hyperliquid-testnet.xyz/info` and `wss://api.hyperliquid-testnet.xyz/ws`.
