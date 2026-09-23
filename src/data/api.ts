import { numeric, parseCandles, record, type Market } from './types';

export const REST_URL = 'https://api.hyperliquid-testnet.xyz/info';
export const WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';

async function info(body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(REST_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`Testnet request failed (${response.status})`);
  return response.json();
}

export async function fetchMarkets(signal?: AbortSignal): Promise<Market[]> {
  const data = await info({ type: 'meta' }, signal);
  if (!record(data) || !Array.isArray(data.universe)) throw new Error('Unexpected market metadata');
  const markets = data.universe.flatMap(item => {
    if (!record(item) || item.isDelisted || typeof item.name !== 'string') return [];
    const decimals = numeric(item.szDecimals);
    return decimals !== null && decimals >= 0 && decimals <= 8
      ? [{ name: item.name, sizeDecimals: decimals }] : [];
  });
  const preferred = ['BTC', 'ETH', 'SOL'];
  markets.sort((a, b) => {
    const rank = (name: string) => preferred.includes(name) ? preferred.indexOf(name) : 3;
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });
  if (!markets.length) throw new Error('No active testnet markets found');
  return markets;
}

export async function fetchHistory(coin: string, signal: AbortSignal) {
  const endTime = Date.now();
  const data = await info({ type: 'candleSnapshot', req: {
    coin, interval: '1m', startTime: endTime - 200 * 60_000, endTime,
  } }, signal);
  if (!Array.isArray(data)) throw new Error('Unexpected candle history');
  return parseCandles(data, coin);
}
