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
function setup(coin = 'BTC') {
  const store = createMarketStore();
  const sockets: FakeSocket[] = [];
  const historyCalls: { resolve: (value: Candle[]) => void; signal: AbortSignal }[] = [];
  const deps = {
    socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    history: (_coin: string, signal: AbortSignal) => new Promise<Candle[]>(resolve => historyCalls.push({ resolve, signal })),
    frame: (callback: () => void) => setTimeout(callback, 16) as unknown as number,
    cancelFrame: (id: number) => clearTimeout(id), random: () => 0,
  };
  const feed = new MarketFeed(store, coin, deps);
  feed.start();
  return { feed, store, sockets, historyCalls, deps };
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
    expect(store.getState().trades[0].time).toBe(69);
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
});
