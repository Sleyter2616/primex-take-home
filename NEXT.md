# Resume checkpoint: 2026-09-23

Checkpoint **c** is complete (commit `feat: complete checkpoint c`). Next: review with `/codex:review --base 6a8c5d9`, fixing only correctness or requirement gaps.

## Checkpoint c completed (2026-09-23, Claude Code)

- Profiler counters moved to `src/perf/metrics.ts` (no React import); `feed.ts` no longer imports from `src/ui`.
- `Header` and `ConnectionStatus` are profiled under separate ids; the duplicated DEV/non-DEV header JSX and per-panel ternaries are gone. `App` renders `ProfileControls` only when `profiling` is true, so the production bundle contains no profiler code (Sol review found an earlier stub; fixed).
- Stale rule fixed: a panel is stale only when it shows retained data while not live (`staleLabel` in `store.ts`, 2 new tests). Before, empty panels said "stale" during every initial connect and market switch.
- Phone layout fix: the PERP badge overlapped the mid price at 375 px; the picker no longer shrinks below its content.
- Profiler runs recorded for BTC and ETH (60 s each); numbers, method and caveats are in README "Measured render counts". Testnet was quiet, so the runs show isolation, not throughput.
- Browser-checked: market switch, simulated offline/online, 375/768/1280 widths, no console errors.
- Verification gaps closed 2026-09-24 with a scripted headless Chrome run (54/54 checks, table in README Verification): markets failure and Retry, rapid and settled BTC/ETH/BTC, blocked candle history, real network offline and restore, switching while offline, phone layout in every error state. Fixed three error-state display bugs it found.
- README: Trade-offs section, 200-minute history window, no trade replay, limitations. 31 tests, typecheck and build pass.

## Failure-state pass (2026-09-24, Claude Code)

- Every panel heading names the coin; stale labels add the last update time (chart caption, order book footer); badge says recovery is automatic; market-list error says it needs Retry.
- Chart shows history failures in place, says whether book and trades are live, and offers a manual Retry after the one automatic retry fails. Before, a failed history could only recover on a reconnect that a healthy socket never triggers.
- `scripts/verify-lifecycle.mjs` committed: 64/64 checks on live testnet, phone viewport. Render profile re-recorded in headless Chrome on current code (README). 34 tests, typecheck, build pass.
- README: Failure states table, Limitations, and Next steps with more time.
- Codex review of `028b7a6` (gpt-6-sol, medium) found two gaps, both fixed with per-panel freshness: a reconnect cleared stale labels before fresh data arrived (high), and the chart notice could call book and trades live before they delivered (medium). 37 tests; lifecycle script 64/64; profile re-recorded.
- Re-review (gpt-6-sol, low) found timestamp ordering fragile and empty history marking candles fresh; freshness now uses a monotonic connection counter and ignores empty history. README row corrected. 38 tests; lifecycle 65/65; profile re-recorded.

## Checkpoint c: state at pause (history)

Codex paused checkpoint c at `0483b91` with stale indications, the `onopen` offline-flag fix and test, and the dev-only profiler. The three open issues it listed (merged profiler id, data layer importing UI, no recorded run) are resolved above.

## Completed

- Local Mac repository initialized; pre-resume snapshot: `7bb5d78`.
- Baseline: 11 tests, TypeScript and build passed.
- Reviewed all 12 requirements and printed the pre-edit report and real payload excerpts in chat.
- Fresh testnet metadata confirms BTC, ETH and SOL. Fresh one-minute candleSnapshot returned valid candles. Saved WebSocket payloads from September 22 verify `tid`, full book snapshots, and object-shaped candle messages.
- Installed Lightweight Charts 5.2.1; using `addSeries(CandlestickSeries, ...)`.
- Checkpoint a: history timeout explicitly cleared on disposal, reconnect guarded by ownership, subscription-send exceptions reconnect cleanly, `dispose()` exposed and used by React cleanup, subscription errors shown inline.
- Added regression tests for disposal with never-settling history, obsolete retry ownership and subscription-send failures.
- Verification after a: 14 tests pass; explicit typecheck and production build pass.

## Checkpoint b completed

- Addressed all six review findings: network events, numeric tid tie-break, one-shot history retry, rejected-ID count/log plus real fixture, reconnect buffer flush, and documented unbounded retries capped at 15 seconds including jitter.
- Added scrambled/overlapping trade input checks with exact retained identities, REST-before-frame and reconnect-gap candle tests, populated A → B → A with obsolete retry response rejection, and capped-backoff/disposal tests.
- 29 tests, explicit typecheck and production build pass. No browser performance evidence collected at this checkpoint.

## Unverified / limitations

- Render counts measured only on a quiet testnet feed; no high-volume replay and no frame timings.
- Candle revision `n` is not treated as a protocol sequence number. Same-minute out-of-order live revisions remain a documented limitation; confirm a server ordering contract before adding heuristics.
- Reconnect fills only the retained history window, not arbitrary-duration gaps. Trade replay is not guaranteed.
- No Git remote configured; code is durable on the user's Mac and available to a local Claude reviewer. No deployment or submission performed.
