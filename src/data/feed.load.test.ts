// SYNTHETIC LOAD: generated messages, not Hyperliquid data. Drives the real MarketFeed parsing,
// buffering and flush path with bursts far above observed testnet rates.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketFeed, type SocketLike } from './feed';
import { createMarketStore } from './store';
import type { Candle, Trade } from './types';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send() {}
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(channel: string, data: unknown) { this.onmessage?.({ data: JSON.stringify({ channel, data }) }); }
}

// Deterministic pseudo-random numbers so failures reproduce.
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed / 2 ** 32; };
}
const bookWire = (time: number, mid: number) => ({ coin: 'BTC', time, levels: [
  Array.from({ length: 20 }, (_, i) => ({ px: String(mid - 1 - i), sz: '1', n: 1 })),
  Array.from({ length: 20 }, (_, i) => ({ px: String(mid + 1 + i), sz: '1', n: 1 })),
] });
const tradeWire = (tid: number, time: number) => ({ coin: 'BTC', tid, time, px: '100', sz: '1', side: tid % 2 ? 'B' : 'A' });
const candleWire = (minute: number, close: number) =>
  ({ s: 'BTC', i: '1m', t: minute * 60_000, o: '100', h: String(Math.max(100, close) + 1), l: String(Math.min(100, close) - 1), c: String(close) });

function setup() {
  const store = createMarketStore();
  const socket = new FakeSocket();
  const feed = new MarketFeed(store, 'BTC', {
    socket: () => socket,
    history: () => new Promise<Candle[]>(() => {}), // history in flight for the whole test
    frame: callback => setTimeout(callback, 16) as unknown as number,
    cancelFrame: id => clearTimeout(id),
    networkEvents: null, warn: () => {},
  });
  feed.start(); socket.open();
  // Private buffers, read only to prove they stay bounded.
  const buffers = feed as unknown as { pendingBook: unknown; pendingTrades: Trade[]; pendingCandles: Candle[]; liveDuringHistory: Candle[] | null };
  let updates = 0; store.subscribe(() => updates++);
  return { feed, store, socket, buffers, updates: () => updates };
}

describe('synthetic burst load through the real feed path', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes only the newest of 5,000 out-of-order book snapshots, in one store update', () => {
    const { feed, store, socket, updates } = setup();
    const random = rng(1);
    const times = Array.from({ length: 5000 }, (_, i) => i + 1).sort(() => random() - 0.5);
    const before = updates();
    for (const time of times) socket.emit('l2Book', bookWire(time, 50_000 + time));
    expect(updates() - before).toBe(0);
    vi.advanceTimersByTime(16);
    expect(updates() - before).toBe(1);
    expect(store.getState().book?.time).toBe(5000);
    expect(store.getState().book?.bids[0].price).toBe(50_000 + 5000 - 1);
    feed.dispose();
  });

  it('keeps exactly the newest 50 unique trades from 400 shuffled batches with duplicates, buffer never above 50', () => {
    const { feed, store, socket, buffers } = setup();
    const random = rng(2);
    const sent = new Map<string, { tid: number; time: number }>();
    let maxPending = 0;
    for (let batch = 0; batch < 400; batch++) {
      const trades = Array.from({ length: 25 }, () => {
        const tid = Math.floor(random() * 20_000); // collisions produce duplicates across batches
        const time = 1_000_000 + Math.floor(tid / 3); // equal times exercise the tid tie-break
        sent.set(`BTC:${time}:${tid}`, { tid, time });
        return tradeWire(tid, time);
      });
      socket.emit('trades', trades);
      maxPending = Math.max(maxPending, buffers.pendingTrades.length);
      if (batch % 50 === 49) vi.advanceTimersByTime(16); // some batches span frames
    }
    vi.advanceTimersByTime(16);
    const expected = [...sent.entries()].sort(([, a], [, b]) => b.time - a.time || b.tid - a.tid).slice(0, 50).map(([id]) => id);
    expect(store.getState().trades.map(trade => trade.id)).toEqual(expected);
    expect(maxPending).toBeLessThanOrEqual(50);
    expect(sent.size).toBeGreaterThan(5000);
    feed.dispose();
  });

  it('keeps candle buffers at or below 300 while 20,000 revisions arrive across 1,000 minutes', () => {
    const { feed, store, socket, buffers } = setup();
    const random = rng(3);
    const latest = new Map<number, number>();
    let maxPending = 0, maxDuringHistory = 0;
    for (let i = 0; i < 20_000; i++) {
      const minute = 1000 + Math.floor(random() * 1000);
      const close = 100 + Math.round(random() * 50);
      latest.set(minute, close);
      socket.emit('candle', candleWire(minute, close));
      maxPending = Math.max(maxPending, buffers.pendingCandles.length);
      maxDuringHistory = Math.max(maxDuringHistory, buffers.liveDuringHistory?.length ?? 0);
    }
    vi.advanceTimersByTime(16);
    const candles = store.getState().candles;
    const newest = [...latest.keys()].sort((a, b) => a - b).slice(-300);
    expect(candles.map(candle => candle.time)).toEqual(newest.map(minute => minute * 60));
    expect(candles.map(candle => candle.close)).toEqual(newest.map(minute => latest.get(minute)));
    expect(maxPending).toBeLessThanOrEqual(300);
    expect(maxDuringHistory).toBeLessThanOrEqual(300);
    feed.dispose();
  });

  it('publishes once per frame over 100 frames of mixed sustained load', () => {
    const { feed, store, socket, buffers, updates } = setup();
    let time = 0, tid = 0;
    const before = updates();
    for (let frame = 0; frame < 100; frame++) {
      for (let i = 0; i < 50; i++) socket.emit('l2Book', bookWire(++time, 50_000));
      for (let i = 0; i < 20; i++) socket.emit('trades', [tradeWire(++tid, 2_000_000 + tid), tradeWire(++tid, 2_000_000 + tid)]);
      for (let i = 0; i < 10; i++) socket.emit('candle', candleWire(5000 + frame, 120 + i));
      expect(buffers.pendingTrades.length).toBeLessThanOrEqual(50);
      vi.advanceTimersByTime(16);
    }
    expect(updates() - before).toBe(100);
    expect(store.getState().book?.time).toBe(time);
    expect(store.getState().trades[0].tid).toBe(tid);
    expect(store.getState().trades).toHaveLength(50);
    expect(buffers.pendingBook).toBeNull();
    feed.dispose();
  });
});
