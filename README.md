# Hyperliquid testnet market terminal

A read-only market screen for Hyperliquid **testnet** perpetuals: a live order book, the latest trades and a one-minute price chart. No wallet or login needed.

**Live:** https://hyperliquid-testnet-terminal.vercel.app

## Run it

Needs Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Then open http://127.0.0.1:5173. To check everything:

```sh
npm test && npm run typecheck && npm run build
```

## What it shows

- **Markets:** every active perpetual on testnet, with BTC, ETH and SOL first.
- **Order book:** 20 price levels on each side, with size, running total and depth bars.
- **Trades:** the latest 50, newest first, marked buy or sell, in UTC.
- **Chart:** one-minute candles, starting with 200 minutes of history and then updating live.

Left out on purpose: trading, wallets, login, other chart intervals and saved settings.

## How it works

```text
REST: market list ──────────────► market selector
REST: 200 min of candles ─────┐
WebSocket: book, trades,      ▼
candles ──► validate ──► buffer ──► store ──► order book, trades, summary
                                        └──► chart (updated directly)
```

Four ideas carry the design:

1. **One owner per market.** Picking a market creates a `MarketFeed` that owns its WebSocket, its timers and its history request. Switching markets shuts all of it down, and anything that arrives late from the old market is ignored.
2. **The screen updates at most once per frame.** Incoming messages are checked, then held in a small buffer: only the newest order book, the newest 50 unique trades and the newest 300 candles. Once per animation frame, the buffer writes to one shared store.
3. **Each panel reads only its own data.** A new trade doesn't redraw the order book. New candles go from the store straight to the charting library, bypassing React, so they never re-render the page.
4. **The screen says when data is old.** A panel counts as fresh only if its data arrived on the current connection. Otherwise it's labelled stale, with the time of its last update.

| File | Job |
|---|---|
| `src/data/feed.ts` | WebSocket, reconnects, timers, the buffer |
| `src/data/types.ts` | Checking incoming data, sorting, de-duplicating |
| `src/data/store.ts` | Shared state and the freshness rule |
| `src/data/api.ts` | Testnet addresses and REST calls |
| `src/ui/` | The panels and the chart |

## When something goes wrong

| What happens | What you see | How it recovers |
|---|---|---|
| The market list can't load | An error message with a **Retry** button | You click Retry |
| The connection drops | "Reconnecting automatically"; data marked stale with its last update time | Automatically, retrying with a growing delay of up to 15 seconds |
| The browser goes offline | "Offline · will reconnect"; data marked stale | Automatically, when the browser is back online |
| The chart's history fails to load | A notice on the chart; the order book and trades keep working | Retries once after 5 seconds, then shows a **Retry** button |

Every panel heading names the market, so numbers are never shown under the wrong name. After a reconnect the chart refills the last 200 minutes; trades missed while disconnected are not replayed.

## Performance

- **On the real testnet feed** (quiet: about 11 order-book updates a minute), the header, market selector and chart component never re-rendered, and the order book re-rendered once per update.
- **Under synthetic load** (generated data, not Hyperliquid: 200 order-book updates a second plus one burst of 5,000 messages), the newest data was always on screen and memory stayed flat. The page held 60 frames per second with no long tasks, and 1,508 chart updates caused zero chart re-renders.
- **Not yet measured:** real mainnet traffic, slower devices and long sessions.

Methods, raw numbers and limits: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Testing

| Command | What it checks |
|---|---|
| `npm test` | 42 unit tests: data parsing, ordering, reconnects, fast market switching, cleanup, stale labels and synthetic bursts. No network needed. |
| `node scripts/verify-lifecycle.mjs <url>` | Browser checks against live testnet: failed requests, going offline, fast switching, phone layout. Needs `npm run dev` and Google Chrome. Last run: 65 of 65 passed. |
| `node scripts/load-harness.mjs <url>` | The synthetic load test in headless Chrome. The page shows a banner saying the data is generated. |

These checks, plus independent reviews by a second AI model (Codex), found real bugs that are now fixed. The worst: after a reconnect the screen briefly showed old numbers as current, and the chart's loading message was invisible. The full list is in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Trade-offs

| Decision | Why | Cost |
|---|---|---|
| A new WebSocket for each market | Switching markets cleans up completely | One extra connection handshake per switch |
| Update the screen once per frame | Work depends on screen speed, not message volume | Up to one frame (about 16 ms) of delay |
| Chart updated outside React | New candles don't re-render anything | Chart code is imperative rather than declarative |
| Keep reconnecting, at most 15 seconds apart | The screen recovers without the user doing anything | None for a read-only screen |
| Retry chart history once, then offer a button | Never hammers the server, never gets stuck | One click after two failures |
| Judge freshness by connection, not by clock | Clock changes can't make old data look current | A little extra state per panel |
| Plain JavaScript numbers | Fine for display | Not precise enough for placing orders |
| No list virtualization | Only 90 rows on screen | Would need revisiting for deeper books |
| Measurement tools only in dev and test builds | Nothing extra ships to users | Render counts can only be reproduced on a dev build |

The reasoning behind each one: [docs/VERIFICATION.md](docs/VERIFICATION.md#trade-offs-in-detail).

## Known limits

- Trades missed during a disconnect aren't replayed or marked as a gap.
- If one data channel goes quiet while the connection stays up, it isn't flagged.
- Out-of-order candle updates within the same minute aren't detected.
- The browser scripts need live testnet and a local Chrome, so they aren't part of `npm test`.

## Next steps with more time

1. Replay recorded mainnet traffic through the load test, on slower laptops and phones.
2. Run the browser checks in CI against recorded data, and add keyboard and accessibility checks.
3. Mark trade gaps in the tape after a reconnect.
4. Flag a data channel that goes quiet on a live connection.
5. Use one WebSocket across market switches, once those tests exist.

## Built with

React and TypeScript, Vite, Zustand (state), TradingView Lightweight Charts, Vitest.

## References

- [Hyperliquid WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- [Hyperliquid info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Timeouts and heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats)
- [Lightweight Charts documentation](https://tradingview.github.io/lightweight-charts/docs)
