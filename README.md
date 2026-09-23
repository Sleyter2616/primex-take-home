# Hyperliquid testnet market terminal

A single-page, read-only perpetuals terminal with a live order book, recent trades, and a one-minute candlestick chart. Market discovery and every data request use **testnet**. No credentials or wallet are required.

## Run

Requires Node.js 22.12 or newer. From this directory:

```sh
npm ci && npm run dev
```

Open the URL printed by Vite (normally http://127.0.0.1:5173).

```sh
npm test       # deterministic parsing, buffering and lifecycle tests
npm run build # TypeScript checks and production build
npm run preview
```

## Scope

- Active perpetuals from testnet metadata, with BTC, ETH and SOL listed first.
- Up to 20 bid and ask levels, price, base-asset size, cumulative size, and proportional depth bars. Asks are displayed above bids; accumulation starts at the best price on each side.
- Latest 50 unique trades, newest first, with aggressor side and UTC time.
- One-minute candles, seeded with approximately 200 minutes of history and updated live. At most 300 candles are retained.
- Loading, empty, REST failure, connection and stale-data states; automatic reconnect and resubscription.

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

`src/data/api.ts` owns the fixed testnet endpoints and REST requests. `types.ts` validates incoming fields and implements ordering, deduplication, depth accumulation and bounded merges. `feed.ts` owns sockets, timers, history requests and the animation-frame buffer. Views live in `src/ui/`.

The book feed provides complete snapshots, so only the newest snapshot within a frame needs to reach the screen. Trades are accumulated and deduplicated before publishing, preserving the newest 50 executions. Candles merge by opening timestamp. Updates publish at most once per animation frame; individual React panels select their own slices. Book rows compare their displayed values, and existing trade rows retain stable keys. A book tick does not rerender the entire application.

The chart subscribes directly to the store. Changed candles use the chart library's imperative `update` API. Initial history, refreshed history and movement of the bounded window use `setData`. The chart instance survives market changes and is removed on component teardown.

Each selected market owns one socket with three subscriptions. A market switch tears down that session and starts another. This costs an extra handshake but simplifies ownership within the exercise's time budget. A generation guard, selected-market check and abort controller prevent obsolete socket or REST callbacks from contaminating the new market, including BTC → ETH → BTC races. Strict Mode cleanup follows the same path.

Reconnect uses capped exponential backoff with jitter, resubscribes, and refreshes candle history. Heartbeats run every 15 seconds; a silent connection is detected on a heartbeat check after 35 seconds without a message. Socket establishment times out after 10 seconds and history after 12 seconds. Retained book/trades are marked stale while reconnecting. During a history request, live candles are preserved and overlaid on the REST response so late history cannot roll back those updates.

## Libraries

- **React + TypeScript:** typed components and explicit data contracts.
- **Vite:** a small client-only development/build setup; this UI needs no application server.
- **Zustand:** a vanilla store usable both by React selectors and the imperative chart adapter.
- **TradingView Lightweight Charts:** performant candlesticks, zooming and panning. Attribution is retained in the UI.
- **Vitest:** deterministic socket/timer tests without depending on testnet activity.

## Verification

The automated suite covers snapshot ordering and depth, malformed inputs, trade deduplication and caps, both candle payload shapes, history/live merging, frame coalescing, unrelated slice identity, late-market callbacks, reconnect/resubscribe, heartbeat timeout and teardown.

The development screen was also checked against real testnet feeds in a browser. Automated lifecycle tests simulate connection failures; they are not a substitute for a production soak test or measured browser performance profile.

## Trade-offs and next steps

- Measure frame times, React commits and memory under a recorded high-volume feed before choosing any heavier optimization. There are only 40 book rows and 50 trade rows, so virtualization is unnecessary for this scope.
- Add browser automation for rapid market switching, offline/online recovery, keyboard access and mobile layout. Extend per-channel freshness indicators: the current badge reports socket health, not a guarantee that every channel is fresh.
- Recover and clearly mark trade gaps after disconnect. The tape currently merges what the subscription sends; it does not promise a complete execution history.
- Retry failed history independently of socket reconnection and offer an explicit retry control.
- Add stricter protocol/schema coverage, including candle revision ordering within the same minute, and recorded fixture replay. Numerical display uses JavaScript numbers, adequate for this read-only slice; order entry would need explicit decimal and tick-size rules.
- Consider retaining a socket across market changes once subscription acknowledgements and reconnect behavior have broader coverage.

The application deliberately excludes trading, authentication, wallet integration, order forms, alternate candle intervals and persistence.

## References

- [Hyperliquid WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- [Hyperliquid info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Timeouts and heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats)
- [Lightweight Charts documentation](https://tradingview.github.io/lightweight-charts/docs)

Endpoints: `https://api.hyperliquid-testnet.xyz/info` and `wss://api.hyperliquid-testnet.xyz/ws`.
