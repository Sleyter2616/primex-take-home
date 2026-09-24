import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketFeed, type SocketLike } from './feed';
import { createMarketStore } from './store';
import type { Candle } from './types';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: unknown[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(channel: string, data: unknown) { this.onmessage?.({ data: JSON.stringify({ channel, data }) }); }
}
const book = (coin = 'BTC', time = 1) => ({ coin, time, levels: [
  [{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }],
] });
function setup(coin = 'BTC', random = () => 0) {
  const store = createMarketStore();
  const sockets: FakeSocket[] = [];
  const historyCalls: { resolve: (value: Candle[]) => void; reject: (reason: Error) => void; signal: AbortSignal; coin: string }[] = [];
  const events = new EventTarget();
  const warn = vi.fn();
  const deps = {
    socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    history: (coin: string, signal: AbortSignal) => new Promise<Candle[]>((resolve, reject) => historyCalls.push({ resolve, reject, signal, coin })),
    networkEvents: events, warn,
    frame: (callback: () => void) => setTimeout(callback, 16) as unknown as number,
    cancelFrame: (id: number) => clearTimeout(id), random,
  };
  const feed = new MarketFeed(store, coin, deps);
  feed.start();
  return { feed, store, sockets, historyCalls, deps, events, warn };
}

describe('selected-market lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces book snapshots, preserves trade batches and leaves unrelated slice references unchanged', () => {
    const { feed, store, sockets } = setup();
    sockets[0].open();
    const originalCandles = store.getState().candles;
    const listener = vi.fn(); const unsubscribe = store.subscribe(listener);
    sockets[0].emit('l2Book', book('BTC', 1));
    sockets[0].emit('l2Book', book('BTC', 2));
    for (let i = 0; i < 70; i++) sockets[0].emit('trades', [{ coin: 'BTC', tid: i, time: i, px: '100', sz: '1', side: 'B' }]);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().book?.time).toBe(2);
    expect(store.getState().trades).toHaveLength(50);
    expect(store.getState().trades.map(t => t.tid)).toEqual(Array.from({ length: 50 }, (_, i) => 69 - i));
    expect(store.getState().candles).toBe(originalCandles);
    const previousTrades = store.getState().trades;
    sockets[0].emit('l2Book', book('BTC', 3)); vi.advanceTimersByTime(16);
    expect(store.getState().trades).toBe(previousTrades);
    unsubscribe(); feed.stop();
  });

  it('merges late REST history with live candles already flushed to the screen', async () => {
    const { feed, store, sockets, historyCalls } = setup();
    sockets[0].open();
    sockets[0].emit('candle', { s: 'BTC', i: '1m', t: 60_000, o: '100', h: '110', l: '99', c: '108' });
    vi.advanceTimersByTime(16);
    historyCalls[0].resolve([{ time: 60, open: 100, high: 102, low: 99, close: 101 }]);
    await Promise.resolve();
    expect(store.getState().candles[0].close).toBe(108);
    expect(store.getState().historyLoading).toBe(false);
    feed.stop();
  });

  it('ignores old socket callbacks and late REST responses after BTC → ETH → BTC', async () => {
    const first = setup(); first.sockets[0].open();
    const oldCallback = first.sockets[0].onmessage!;
    first.feed.stop();
    const eth = new MarketFeed(first.store, 'ETH', first.deps); eth.start(); eth.stop();
    const btc = new MarketFeed(first.store, 'BTC', first.deps); btc.start();
    expect(first.historyCalls[0].signal.aborted).toBe(true);
    oldCallback({ data: JSON.stringify({ channel: 'l2Book', data: book() }) });
    first.historyCalls[0].resolve([{ time: 60, open: 1, high: 1, low: 1, close: 1 }]);
    await Promise.resolve(); vi.advanceTimersByTime(16);
    expect(first.store.getState().book).toBeNull();
    expect(first.store.getState().candles).toEqual([]);
    btc.stop();
  });

  it('reconnects once after close/error, restores exactly three subscriptions and refetches history', () => {
    const { feed, sockets, historyCalls, store } = setup(); sockets[0].open();
    const close = sockets[0].onclose!, error = sockets[0].onerror!;
    close(); error();
    expect(store.getState().connection).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent).toHaveLength(3);
    expect(historyCalls).toHaveLength(2);
    expect(historyCalls[0].signal.aborted).toBe(true);
    feed.stop();
  });

  it('heartbeats a quiet socket, reconnects an unresponsive socket, and cancels retries on teardown', () => {
    const { feed, sockets } = setup(); sockets[0].open();
    vi.advanceTimersByTime(15_000);
    expect(sockets[0].sent).toContainEqual({ method: 'ping' });
    vi.advanceTimersByTime(30_000);
    expect(sockets[0].readyState).toBe(3);
    feed.stop(); vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('teardown cancels a queued frame and prevents late history from writing', async () => {
    const { feed, sockets, store, historyCalls } = setup(); sockets[0].open();
    sockets[0].emit('l2Book', book()); feed.stop();
    const state = store.getState();
    historyCalls[0].resolve([]); await Promise.resolve(); vi.advanceTimersByTime(60_000);
    expect(store.getState()).toBe(state);
    expect(sockets[0].sent.filter(item => (item as { method: string }).method === 'unsubscribe')).toHaveLength(3);
  });

  it('dispose clears every timer even when the history promise never settles', () => {
    const { feed, sockets, historyCalls } = setup(); sockets[0].open();
    sockets[0].emit('l2Book', book());
    feed.dispose();
    expect(historyCalls[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('does not reconnect an obsolete session after the selected coin changes', () => {
    const { feed, sockets, store } = setup(); sockets[0].open();
    sockets[0].onclose!();
    store.setState({ coin: 'ETH' });
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(1);
    feed.dispose();
  });

  it('retries a failed subscription send without leaking a heartbeat or history request', () => {
    const { feed, sockets, historyCalls, store } = setup();
    sockets[0].send = () => { throw new Error('connection closed'); };
    sockets[0].open();
    expect(store.getState().connection).toBe('reconnecting');
    expect(historyCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    feed.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe('review regressions and checkpoint b', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const candleWire = (t: number, c = '108') => ({ s: 'BTC', i: '1m', t, o: '100', h: '110', l: '99', c });
  const bar = (time: number, close = 101): Candle => ({ time, open: 100, high: 110, low: 99, close });
  const tradeWire = (tid: number) => ({ coin: 'BTC', tid, time: 1000, px: '100', sz: '1', side: 'B' });

  it('handles offline immediately, online immediately, resets backoff and removes listeners on dispose', () => {
    const { feed, sockets, store, events } = setup(); sockets[0].open();
    sockets[0].onclose!(); vi.advanceTimersByTime(1000);
    sockets[1].onclose!(); // Next delay would be 2s.
    events.dispatchEvent(new Event('offline'));
    expect(store.getState().connection).toBe('offline');
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(store.getState().connection).toBe('live');
    sockets[2].onclose!();
    expect(store.getState().connection).toBe('reconnecting'); // onopen cleared the offline flag.
    events.dispatchEvent(new Event('online'));
    expect(sockets[2].readyState).toBe(3);
    expect(sockets).toHaveLength(4);
    expect(store.getState().connection).toBe('reconnecting');
    sockets[3].onclose!();
    vi.advanceTimersByTime(999); expect(sockets).toHaveLength(4);
    vi.advanceTimersByTime(1); expect(sockets).toHaveLength(5);
    feed.dispose();
    const state = store.getState();
    events.dispatchEvent(new Event('offline')); events.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(5); expect(store.getState()).toBe(state);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries history once at 5s while live, then offers a manual retry', async () => {
    const { feed, sockets, historyCalls, store } = setup(); sockets[0].open();
    historyCalls[0].reject(new Error('REST failed')); await Promise.resolve();
    expect(store.getState().historyError).toContain('5 seconds');
    vi.advanceTimersByTime(4999); expect(historyCalls).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(historyCalls).toHaveLength(2);
    historyCalls[1].reject(new Error('REST failed again')); await Promise.resolve();
    vi.advanceTimersByTime(5000); expect(historyCalls).toHaveLength(2);
    expect(sockets).toHaveLength(1); expect(store.getState().connection).toBe('live');
    expect(store.getState().historyError).toContain('Automatic retry failed');
    const retry = store.getState().historyRetry;
    expect(retry).toBeTypeOf('function');
    retry!(); expect(historyCalls).toHaveLength(3);
    expect(store.getState().historyRetry).toBeNull(); expect(store.getState().historyLoading).toBe(true);
    historyCalls[2].resolve([{ time: 60, open: 100, high: 102, low: 99, close: 101 }]); await Promise.resolve();
    expect(store.getState().historyError).toBeNull(); expect(store.getState().candles).toHaveLength(1);
    feed.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the manual history retry on reconnect and says history reloads after reconnecting', async () => {
    const { feed, sockets, historyCalls, store } = setup(); sockets[0].open();
    historyCalls[0].reject(new Error('failed')); await Promise.resolve();
    vi.advanceTimersByTime(5000); historyCalls[1].reject(new Error('failed')); await Promise.resolve();
    const obsolete = store.getState().historyRetry!;
    sockets[0].onclose!();
    expect(store.getState().historyRetry).toBeNull();
    expect(store.getState().historyError).toContain('after reconnecting');
    obsolete(); expect(historyCalls).toHaveLength(2);
    vi.advanceTimersByTime(1000); sockets[1].open(); expect(historyCalls).toHaveLength(3);
    expect(store.getState().historyError).toBeNull();
    feed.dispose();
  });

  it('records when live data was last published and resets it for a new market', () => {
    vi.setSystemTime(1_000_000);
    const { feed, sockets, store } = setup(); sockets[0].open();
    expect(store.getState().lastUpdateAt).toBeNull();
    sockets[0].emit('l2Book', book('BTC', 1)); vi.advanceTimersByTime(16);
    expect(store.getState().lastUpdateAt).toBe(1_000_016);
    feed.dispose();
    const next = new MarketFeed(store, 'ETH', { socket: () => new FakeSocket(), history: () => new Promise(() => {}) });
    next.start(); expect(store.getState().lastUpdateAt).toBeNull();
    next.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a scheduled history retry on reconnect and disposal', async () => {
    const { feed, sockets, historyCalls } = setup(); sockets[0].open();
    historyCalls[0].reject(new Error('failed')); await Promise.resolve();
    sockets[0].onclose!(); vi.advanceTimersByTime(1000); sockets[1].open();
    vi.advanceTimersByTime(4000); expect(historyCalls).toHaveLength(2);
    historyCalls[1].reject(new Error('failed')); await Promise.resolve();
    feed.dispose(); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(6000); expect(historyCalls).toHaveLength(2);
  });

  it('counts and logs unsafe tids while retaining valid trades, including same-ms ordering', () => {
    const { feed, sockets, store, warn } = setup(); sockets[0].open();
    sockets[0].emit('trades', [tradeWire(9), tradeWire(Number.MAX_SAFE_INTEGER + 1), tradeWire(10)]);
    sockets[0].emit('trades', [tradeWire(1.5)]);
    vi.advanceTimersByTime(16);
    expect(store.getState().trades.map(t => t.tid)).toEqual([10, 9]);
    expect(store.getState().rejectedTradeIds).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[BTC] Rejected 1 trades: tid must be a safe integer.');
    feed.dispose();
  });

  it('flushes pending trades and candles before reconnect, without waiting for a frame', () => {
    const { feed, sockets, store } = setup(); sockets[0].open();
    sockets[0].emit('trades', [tradeWire(9)]);
    sockets[0].emit('trades', [tradeWire(10)]);
    sockets[0].emit('candle', candleWire(60_000));
    expect(store.getState().trades).toEqual([]);
    sockets[0].onclose!();
    expect(store.getState().trades.map(t => t.tid)).toEqual([10, 9]);
    expect(store.getState().candles[0].close).toBe(108);
    expect(store.getState().connection).toBe('reconnecting');
    feed.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('never flushes a disposed or replaced market into the current market', () => {
    const { feed, sockets, store, events } = setup(); sockets[0].open();
    sockets[0].emit('trades', [tradeWire(9)]); sockets[0].emit('candle', candleWire(60_000));
    store.setState({ coin: 'ETH' }); events.dispatchEvent(new Event('offline'));
    vi.advanceTimersByTime(16);
    expect(store.getState().trades).toEqual([]); expect(store.getState().candles).toEqual([]);
    feed.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves buffered live candles when REST resolves before the frame', async () => {
    const { feed, sockets, store, historyCalls } = setup(); sockets[0].open();
    sockets[0].emit('candle', candleWire(60_000));
    historyCalls[0].resolve([bar(60)]); await Promise.resolve();
    expect(store.getState().candles).toEqual([bar(60, 108)]);
    vi.advanceTimersByTime(16); expect(store.getState().candles).toEqual([bar(60, 108)]);
    feed.dispose();
  });

  it('backfills a reconnect candle gap and overlays new live data', async () => {
    const { feed, sockets, store, historyCalls } = setup(); sockets[0].open();
    historyCalls[0].resolve([bar(60)]); await Promise.resolve();
    sockets[0].onclose!(); vi.advanceTimersByTime(1000); sockets[1].open();
    sockets[1].emit('candle', candleWire(180_000)); vi.advanceTimersByTime(16);
    historyCalls[1].resolve([bar(60), bar(120), bar(180)]); await Promise.resolve();
    expect(store.getState().candles).toEqual([bar(60), bar(120), bar(180, 108)]);
    expect(historyCalls.map(h => h.coin)).toEqual(['BTC', 'BTC']);
    feed.dispose();
  });

  it('retains populated final A through A to B to A and rejects obsolete retry responses', async () => {
    const first = setup(); first.sockets[0].open();
    first.historyCalls[0].reject(new Error('failed')); await Promise.resolve();
    vi.advanceTimersByTime(5000); // retry in flight
    const staleMessage = first.sockets[0].onmessage!;
    first.feed.dispose();
    const eth = new MarketFeed(first.store, 'ETH', first.deps); eth.start(); first.sockets[1].open(); eth.dispose();
    const btc = new MarketFeed(first.store, 'BTC', first.deps); btc.start(); first.sockets[2].open();
    expect(first.sockets[2].sent).toEqual(['l2Book', 'trades', 'candle'].map(type => ({
      method: 'subscribe', subscription: { type, coin: 'BTC', ...(type === 'candle' ? { interval: '1m' } : {}) },
    })));
    first.sockets[2].emit('l2Book', book('BTC', 30));
    first.sockets[2].emit('trades', [tradeWire(10)]);
    first.historyCalls[3].resolve([bar(180)]); await Promise.resolve(); vi.advanceTimersByTime(16);
    staleMessage({ data: JSON.stringify({ channel: 'l2Book', data: book('BTC', 999) }) });
    staleMessage({ data: JSON.stringify({ channel: 'trades', data: [tradeWire(99)] }) });
    first.historyCalls[1].resolve([bar(60)]); first.historyCalls[2].resolve([bar(120)]);
    await Promise.resolve(); vi.advanceTimersByTime(16);
    expect(first.store.getState().book?.time).toBe(30);
    expect(first.store.getState().trades.map(t => t.tid)).toEqual([10]);
    expect(first.store.getState().candles).toEqual([bar(180)]);
    btc.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('retries without a maximum attempt count but caps delay including jitter at 15s', () => {
    const { feed, sockets } = setup('BTC', () => 0.8);
    for (const delay of [1400, 2400, 4400, 8400, 15000, 15000, 15000]) {
      const count = sockets.length;
      sockets.at(-1)!.onclose!();
      vi.advanceTimersByTime(delay - 1); expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1); expect(sockets).toHaveLength(count + 1);
    }
    sockets.at(-1)!.onclose!(); feed.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000); expect(sockets).toHaveLength(8);
  });
});


it('a successful history retry preserves a live candle that arrives while retrying', async () => {
  vi.useFakeTimers();
  const { feed, sockets, historyCalls, store } = setup();
  try {
    sockets[0].open(); historyCalls[0].reject(new Error('failed')); await Promise.resolve();
    vi.advanceTimersByTime(5000);
    sockets[0].emit('candle', { s: 'BTC', i: '1m', t: 60_000, o: '100', h: '110', l: '99', c: '108' });
    historyCalls[1].resolve([{ time: 60, open: 100, high: 102, low: 99, close: 101 }]);
    await Promise.resolve(); vi.advanceTimersByTime(16);
    expect(store.getState().candles[0].close).toBe(108);
    expect(store.getState().historyLoading).toBe(false);
    expect(store.getState().historyError).toBeNull();
  } finally { feed.dispose(); vi.useRealTimers(); }
});
