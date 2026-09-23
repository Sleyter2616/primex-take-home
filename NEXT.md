# Resume checkpoint: 2026-09-23

Checkpoint **b** committed (`6a8c5d9`). Checkpoint **c** was started and paused on 2026-09-23; the partial work is saved in the next `wip:` commit. Implementation continues in Claude Code from here.

## Checkpoint c: state at pause (2026-09-23)

Done (uncommitted work captured in the wip commit):
- Market summary and chart caption show a stale indication whenever the connection is not live.
- `onopen` clears the offline flag; a regression test covers offline, reopen, then close going to `reconnecting`.
- Dev-only render profiler (`src/ui/profile.tsx`): wraps each panel in `<Profiler>` when the page is opened with `?profile=1`, records a 60-second window of panel renders, book messages, trade batches and chart `update`/`setData` calls.
- Verified on a clean install of this tree: 29 tests pass, typecheck and production build pass. Not verified in a browser.

Open issues found at handoff:
- The header and `ConnectionStatus` are both profiled under the id `Header/ConnectionStatus`, so their counts merge. The header JSX is duplicated across the DEV and non-DEV branches.
- `src/data/feed.ts` imports `metric` from `src/ui/profile`, so the data layer now depends on the UI layer. Consider a neutral `src/perf` module.
- No profiler run has been recorded yet, so no render-count numbers exist.


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

## Then: checkpoint c

1. Add explicit chart/summary stale indications and audit visible loading, empty and error states. Inspect responsive behavior in a browser.
2. Record real React Profiler or console render-count observations with an explicit methodology. Store-reference tests alone do not prove render isolation. Do not claim a frame-rate benchmark without measuring it.
3. Update README with measured observations, exact reconnect history window (200 minutes), no guaranteed trade replay, and remaining limitations. Refresh one-command run and architecture notes.
4. Run tests, typecheck and build; commit checkpoint c; stop and report.

## Unverified / limitations

- No new browser run after checkpoints a/b. Prior session verified live BTC, ETH and SOL with no captured console warnings/errors.
- No React render-count measurements yet. Existing README architecture wording describes the intended isolation, not measured evidence.
- Candle revision `n` is not treated as a protocol sequence number. Same-minute out-of-order live revisions remain a documented limitation; confirm a server ordering contract before adding heuristics.
- Reconnect fills only the retained history window, not arbitrary-duration gaps. Trade replay is not guaranteed.
- No Git remote configured; code is durable on the user's Mac and available to a local Claude reviewer. No deployment or submission performed.
