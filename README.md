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

## Scope

- Active perpetuals from testnet metadata, with BTC, ETH and SOL listed first.
- Up to 20 bid and ask levels, price, base-asset size, cumulative size, and proportional depth bars. Asks are displayed above bids; accumulation starts at the best price on each side.
- Latest 50 unique trades, newest first, with aggressor side and UTC time.
- One-minute candles, seeded with approximately 200 minutes of history and updated live. At most 300 candles are retained.
- Loading, empty, REST failure, connection and stale-data states; automatic reconnect and resubscription. A panel is marked stale (`Stale · reconnecting` or `Stale · offline`) only when it is showing retained data while the socket is not live. Before its first data arrives, a panel shows its loading text instead.

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

Failed candle history gets one independent retry after five seconds while the same socket generation remains live. A second failure waits for the next connection. Reconnect and disposal cancel this retry. Trades sort newest timestamp first, then numeric `tid` descending for equal timestamps; the tie-break is deterministic, not a claim that IDs encode execution order. Invalid safe-integer `tid` values are counted in `rejectedTradeIds` for the selected feed and logged once per affected batch without payload contents.

## Measured render counts

Method (2026-09-23, about 19:30 UTC): `npm run dev`, page opened at `/?profile=1` in the Claude desktop app's built-in Chromium 152 browser at 1024 x 768. React Strict Mode on. Each panel is wrapped in a React `<Profiler>`; its `onRender` callback increments a counter once per **commit** of that panel. Strict Mode double rendering does not add commits. The feed and chart adapter count WebSocket book messages, trade batches, and chart `update` / `setData` calls in the same window. After history loaded, the "Measure 60 seconds" button recorded one 60-second window with no user interaction. The raw JSON is printed to the console as `HL_PROFILE_RESULT` and below the button.

| Counter (60 s) | BTC | ETH |
|---|---|---|
| `bookMessages` | 12 | 11 |
| `OrderBook` commits | 12 | 11 |
| `MarketSummary` commits | 6 | 2 |
| `tradeBatches` | 1 | 2 |
| `TradesTape` commits | 1 | 2 |
| `seriesUpdate` (chart API) | 1 | 2 |
| `seriesSetData` (chart API) | 0 | 0 |
| `PriceChart` commits | 0 | 0 |
| `Header`, `ConnectionStatus`, `MarketSelector` commits | 0 | 0 |

What this shows: each panel committed only when its own slice changed. The order book committed once per book message. The summary committed only when best bid, best ask or mid moved. Live candles reached the chart through `update` without a React commit of `PriceChart`. The header, status and selector did not commit at all.

What this does not show:
- Throughput. Testnet was quiet during both windows. A raw WebSocket opened in the same page, subscribed to BTC and ETH for 30 seconds, received 7 book snapshots per coin, so the low counts reflect the feed, not dropped messages. Frame coalescing under a high message rate was not exercised in the browser; it is covered only by the unit tests.
- Timing. These are commit counts from a development build, not frame times or durations. No frame-rate claim is made.
- The browser pane reported `document.visibilityState` as `hidden` (`visibleAtStart: false` in the JSON), but `requestAnimationFrame` was measured running at 76 callbacks in about one second just before the run, so the frame buffer was flushing normally.

Raw results:

```json
{"coin":"BTC","visibleAtStart":false,"visibilityChanges":0,"windowMs":60000,"completedAfterMs":60001,"Header":0,"ConnectionStatus":0,"MarketSelector":0,"MarketSummary":6,"PriceChart":0,"TradesTape":1,"OrderBook":12,"bookMessages":12,"tradeBatches":1,"seriesUpdate":1,"seriesSetData":0}
{"coin":"ETH","visibleAtStart":false,"visibilityChanges":0,"windowMs":60000,"completedAfterMs":60002,"Header":0,"ConnectionStatus":0,"MarketSelector":0,"MarketSummary":2,"PriceChart":0,"TradesTape":2,"OrderBook":11,"bookMessages":11,"tradeBatches":2,"seriesUpdate":2,"seriesSetData":0}
```

## Libraries

- **React + TypeScript:** typed components and explicit data contracts.
- **Vite:** a small client-only development/build setup; this UI needs no application server.
- **Zustand:** a vanilla store usable both by React selectors and the imperative chart adapter.
- **TradingView Lightweight Charts:** performant candlesticks, zooming and panning. Attribution is retained in the UI.
- **Vitest:** deterministic socket/timer tests without depending on testnet activity.

## Verification

The automated suite (31 tests) covers the stale-label rule, offline/online events, the exact backoff cap including jitter, one-shot history retry, rejection diagnostics, a real captured trades fixture, reconnect flushing, snapshot ordering and depth, malformed inputs, trade deduplication and caps, both candle payload shapes, history/live merging, frame coalescing, unrelated slice identity, late-market callbacks, reconnect/resubscribe, heartbeat timeout and teardown.

Scripted lifecycle checks, 2026-09-24 about 00:30 UTC, against live testnet and the dev server. Headless Chrome 153, fresh profile, phone viewport 375 x 812 with a 1280 x 800 capture of the markets error, driven over the Chrome DevTools Protocol. The script fails only the chosen REST request type (`meta` or `candleSnapshot`) with `Fetch.failRequest`, cuts the network with `Network.emulateNetworkConditions` (real offline: `navigator.onLine` false, new sockets fail), and logs every WebSocket, subscribe and unsubscribe frame and received channel. It also wraps `WebSocket` in the page to record when the app itself calls `close()`, and subscribes to the store to flag any book, trade or candle price that does not fit the selected coin (BTC above 20,000; ETH between 300 and 20,000). Result: 54 of 54 checks passed.

| Scenario | Observed |
|---|---|
| Markets REST failure on first load | Inline `Markets unavailable` row with `Retry` in its own row (no overlap at either width); badge `Waiting for markets`; chart `Waiting for market list`; no socket opened. Retry loads markets and BTC goes live. |
| Rapid BTC to ETH to BTC (150 ms apart) | 2 sockets created; the ETH one closed before its handshake. One open socket afterwards, subscribed to `l2Book`, `trades` and `candle` for BTC only. |
| Settled BTC to ETH to BTC | Each switch unsubscribes and closes the old socket, then one new socket subscribes only to the new coin. |
| Candle history blocked, switch to ETH | `retrying in 5 seconds`, exactly one retry about 5 s later, then `history retries on reconnection`; no further history requests over the next 8 s; book and trades stay live on one socket. |
| Network offline (history still blocked) | State `offline`; panels with data say `Stale · offline`; the app closes its socket at once; retry sockets at +1.1, +3.3, +7.3 and +15.4 s all failed, none connected. |
| Network restored | One immediate reconnect, history reloads (block lifted), error and stale labels clear, one socket with ETH subscriptions only. |
| Switch to BTC while offline, then restore | No stale labels on the emptied panels while offline; restore reaches BTC live with one BTC-only socket. |
| Whole run | No store update carried a price from the other market; the app never created a socket while another was unclosed; no frames on closed sockets; no uncaught exceptions or console errors; no horizontal overflow in any capture; chart empty-state text rendered above the chart canvas. |

Chrome reports a closed socket only after its close handshake finishes, so under offline emulation a socket the app has already closed still appears open until the network returns; the app-level `close()` record is the source of truth there.

The run found and fixed three display bugs in error states: the markets error was absolutely positioned and covered the chart heading; the chart's loading and waiting text sat under the chart canvases (Lightweight Charts uses z-index 1 to 3) and was invisible at every width; with no market list, the badge said `Connecting` and the chart said `Loading candle history` although nothing was loading.

Earlier manual checks in the desktop app's built-in browser covered 768 and 1280 widths on live data. Automated lifecycle tests simulate connection failures; neither is a substitute for a production soak test.

## Trade-offs

Each entry: the decision, the alternative, and why.

- **One socket per selected market.** Alternative: one shared socket, unsubscribing and resubscribing on market change. A fresh socket per market makes ownership simple: disposal closes everything that market started, and a generation check drops late callbacks. Cost: one extra handshake per switch.
- **Publish at most once per animation frame.** Alternative: write every message to the store. Book messages are full snapshots, so only the newest one in a frame is worth rendering; trades and candles are merged in the buffer. This bounds React work to the display rate regardless of message rate.
- **Vanilla Zustand store read by both React and the chart.** Alternative: React context or a React-only store. The chart subscribes outside React and calls the chart API directly, so live candles do not re-render the chart component (measured: 0 `PriceChart` commits).
- **`update` for changed candles, `setData` only for history, market change or window movement.** Alternative: `setData` on every change. `update` touches one bar; `setData` rebuilds the series.
- **Unbounded reconnect attempts, delay capped at 15 seconds including jitter.** Alternative: give up after N attempts. A read-only market screen should recover by itself when the network returns; the cap keeps recovery prompt, and jitter avoids synchronized retries.
- **One automatic history retry per connection.** Alternative: retry until it succeeds. One retry covers a transient REST failure without hammering the endpoint; the next reconnect tries again.
- **Stale means "not live and showing retained data".** Alternative: stale whenever the socket is not live. The simpler rule labelled empty panels as stale during every initial connect and market switch, which was misleading.
- **Trades sorted by time, then numeric `tid` descending.** Alternative: arrival order. The tie-break makes the order deterministic; it is not a claim that IDs encode execution order.
- **JavaScript numbers for prices and sizes.** Alternative: a decimal library. Adequate for display only; order entry would need exact decimals and tick sizes.
- **No list virtualization.** Alternative: virtualize the book and tape. At 40 book rows and 50 trade rows the DOM is small; row components are memoized instead.
- **Development-only profiler behind `?profile=1`.** Alternative: a permanent metrics layer or an external profiler. It records counts with the same code that runs in development, costs nothing in production (compiled out), and the counters live in `src/perf` so the data layer does not import UI code.

## Limitations and next steps

- Render counts were measured on a quiet testnet feed. Measure again under a recorded high-volume replay before choosing any heavier optimization.
- Reconnect refills only the last 200 minutes of candles. Trades missed during a disconnect are not replayed or marked as a gap.
- The connection badge reports socket health, not per-channel freshness.
- No manual history retry control after the automatic retry is used.
- Candle revision `n` is not treated as a sequence number; same-minute out-of-order live revisions are not detected.
- The lifecycle script used for Verification is not part of this repository or of `npm test`; it needs a local Chrome and a running dev server. Keyboard access has no automated check.
- A shared socket across market changes could be reconsidered once subscription acknowledgements have broader test coverage.

The application deliberately excludes trading, authentication, wallet integration, order forms, alternate candle intervals and persistence.

## References

- [Hyperliquid WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- [Hyperliquid info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Timeouts and heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats)
- [Lightweight Charts documentation](https://tradingview.github.io/lightweight-charts/docs)

Endpoints: `https://api.hyperliquid-testnet.xyz/info` and `wss://api.hyperliquid-testnet.xyz/ws`.
