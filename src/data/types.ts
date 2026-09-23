export interface Market { name: string; sizeDecimals: number }
export interface Level { price: number; size: number; cumulative: number }
export interface Book { time: number; bids: Level[]; asks: Level[] }
export interface Trade {
  id: string; tid: number; time: number; price: number; size: number; side: 'buy' | 'sell';
}
export interface Candle {
  time: number; open: number; high: number; low: number; close: number;
}
export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function numeric(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function levels(value: unknown, direction: 'bid' | 'ask'): Level[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: Level[] = [];
  for (const item of value) {
    if (!record(item)) return null;
    const price = numeric(item.px), size = numeric(item.sz);
    if (price === null || size === null || price <= 0 || size < 0) return null;
    parsed.push({ price, size, cumulative: 0 });
  }
  parsed.sort((a, b) => direction === 'bid' ? b.price - a.price : a.price - b.price);
  let cumulative = 0;
  return parsed.slice(0, 20).map(level => ({ ...level, cumulative: cumulative += level.size }));
}

export function parseBook(value: unknown, coin: string): Book | null {
  if (!record(value) || value.coin !== coin || !Array.isArray(value.levels)) return null;
  const bids = levels(value.levels[0], 'bid'), asks = levels(value.levels[1], 'ask');
  const time = numeric(value.time);
  return bids && asks && time !== null ? { bids, asks, time } : null;
}

export function parseTrades(value: unknown, coin: string, rejectedTid?: () => void): Trade[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!record(item) || item.coin !== coin || !['A', 'B'].includes(String(item.side))) return [];
    if (typeof item.tid !== 'number' || !Number.isSafeInteger(item.tid)) {
      rejectedTid?.();
      return [];
    }
    const price = numeric(item.px), size = numeric(item.sz), time = numeric(item.time);
    if (price === null || size === null || time === null || price <= 0 || size <= 0) return [];
    return [{ id: `${coin}:${time}:${item.tid}`, tid: item.tid, time, price, size,
      side: item.side === 'B' ? 'buy' as const : 'sell' as const }];
  });
}

export function parseCandles(value: unknown, coin: string): Candle[] {
  return (Array.isArray(value) ? value : [value]).flatMap(item => {
    if (!record(item) || item.s !== coin || item.i !== '1m') return [];
    const [t, open, high, low, close] = [item.t, item.o, item.h, item.l, item.c].map(numeric);
    if (t === null || open === null || high === null || low === null || close === null ||
        t < 0 || open <= 0 || low <= 0 || low > Math.min(open, close) ||
        high < Math.max(open, close)) return [];
    return [{ time: Math.floor(t / 1000), open, high, low, close }];
  });
}

export function mergeTrades(current: Trade[], incoming: Trade[]): Trade[] {
  const byId = new Map(current.map(trade => [trade.id, trade]));
  for (const trade of incoming) byId.set(trade.id, trade);
  return [...byId.values()].sort((a, b) => b.time - a.time || b.tid - a.tid).slice(0, 50);
}

/** Later input wins at a timestamp. Used to overlay buffered live data on history. */
export function mergeCandles(current: Candle[], incoming: Candle[]): Candle[] {
  const byTime = new Map(current.map(candle => [candle.time, candle]));
  for (const candle of incoming) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-300);
}
