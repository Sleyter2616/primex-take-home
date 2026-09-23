import fixture from './fixtures/trades-btc-2026-09-22.json';
import { describe, expect, it } from 'vitest';
import { mergeCandles, mergeTrades, parseBook, parseCandles, parseTrades } from './types';

const trade = (id: number, coin = 'BTC') => ({ coin, tid: id, time: id * 1000, px: '100', sz: '2', side: 'B' });
const candle = (t: number, close = '12') => ({ s: 'BTC', i: '1m', t, o: '10', h: '15', l: '8', c: close });

describe('feed transformations', () => {
  it('sorts both book sides best-outward before computing depth', () => {
    const book = parseBook({ coin: 'BTC', time: 1, levels: [
      [{ px: '99', sz: '2' }, { px: '100', sz: '3' }],
      [{ px: '103', sz: '4' }, { px: '101', sz: '1' }],
    ] }, 'BTC');
    expect(book?.bids.map(x => [x.price, x.cumulative])).toEqual([[100, 3], [99, 5]]);
    expect(book?.asks.map(x => [x.price, x.cumulative])).toEqual([[101, 1], [103, 5]]);
  });
  it('rejects another market, non-finite numbers and malformed levels', () => {
    expect(parseBook({ coin: 'ETH', time: 1, levels: [[], []] }, 'BTC')).toBeNull();
    expect(parseBook({ coin: 'BTC', time: 1, levels: [[{ px: 'NaN', sz: '1' }], []] }, 'BTC')).toBeNull();
    expect(parseBook({ coin: 'BTC', time: 1, levels: [[], null] }, 'BTC')).toBeNull();
  });
  it('deduplicates across batches, orders newest first and keeps only the latest 50', () => {
    const first = parseTrades(Array.from({ length: 40 }, (_, i) => trade(i)), 'BTC');
    const second = parseTrades(Array.from({ length: 40 }, (_, i) => trade(i + 20)), 'BTC');
    const result = mergeTrades(first, second);
    expect(result).toHaveLength(50);
    expect(new Set(result.map(x => x.id)).size).toBe(50);
    expect(result[0].time).toBe(59_000);
    expect(result.at(-1)?.time).toBe(10_000);
    expect(result[0].side).toBe('buy');
    expect(parseTrades([trade(1, 'ETH'), { ...trade(2), side: 'unknown' }], 'BTC')).toEqual([]);
  });
  it('accepts observed candle object and documented arrays, with ms-to-seconds conversion', () => {
    expect(parseCandles(candle(120_000), 'BTC')).toEqual(parseCandles([candle(120_000)], 'BTC'));
    expect(parseCandles(candle(120_000), 'BTC')[0].time).toBe(120);
    expect(parseCandles({ ...candle(120_000), i: '5m' }, 'BTC')).toEqual([]);
  });
  it('overlays live candles on history, sorts and bounds history', () => {
    const history = parseCandles([candle(120_000), candle(60_000)], 'BTC');
    const live = parseCandles(candle(120_000, '14'), 'BTC');
    expect(mergeCandles(history, live).map(x => [x.time, x.close])).toEqual([[60, 12], [120, 14]]);
    expect(mergeCandles([], Array.from({ length: 500 }, (_, i) => ({ time: i, open: 1, high: 1, low: 1, close: 1 })))).toHaveLength(300);
  });
});


describe('trade ordering and captured protocol', () => {
  it('orders same-ms tids numerically, independent of input and batch order', () => {
    const nine = { ...trade(9), time: 1000 }, ten = { ...trade(10), time: 1000 };
    for (const input of [[nine, ten], [ten, nine]]) {
      expect(mergeTrades([], parseTrades(input, 'BTC')).map(t => t.tid)).toEqual([10, 9]);
    }
    expect(mergeTrades(parseTrades([ten], 'BTC'), parseTrades([nine, ten], 'BTC')).map(t => t.tid)).toEqual([10, 9]);
  });

  it('retains exactly the newest 50 unique identities from scrambled overlapping batches', () => {
    const all = Array.from({ length: 80 }, (_, i) => trade((i * 37) % 80));
    const first = parseTrades([...all.slice(0, 60), all[5], all[5]], 'BTC');
    const second = parseTrades([...all.slice(20), all[30], all[30]], 'BTC');
    expect(mergeTrades(mergeTrades([], first), second).map(t => t.id))
      .toEqual(Array.from({ length: 50 }, (_, i) => `BTC:${(79 - i) * 1000}:${79 - i}`));
  });

  it('parses every trade in the real captured message and preserves numeric identity', () => {
    let rejected = 0;
    const parsed = parseTrades(fixture.data, 'BTC', () => rejected++);
    expect(parsed).toHaveLength(fixture.data.length);
    expect(parsed[0]).toEqual({ id: 'BTC:1790128583573:628379693827841',
      tid: 628379693827841, time: 1790128583573, price: 86951, size: 0.00212, side: 'buy' });
    expect(rejected).toBe(0);
  });

  it('reports unsafe, fractional and non-numeric tids without rejecting valid peers', () => {
    let rejected = 0;
    const data = [trade(9), ...[Number.MAX_SAFE_INTEGER + 1, 1.5, '10', undefined]
      .map(tid => ({ ...trade(10), tid }))];
    expect(parseTrades(data, 'BTC', () => rejected++).map(t => t.tid)).toEqual([9]);
    expect(rejected).toBe(4);
  });
});
