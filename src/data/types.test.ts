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
