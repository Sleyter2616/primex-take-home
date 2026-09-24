import { createStore } from 'zustand/vanilla';
import type { Book, Candle, Connection, Market, Trade } from './types';

export interface MarketState {
  markets: Market[];
  marketError: string | null;
  coin: string;
  connection: Connection;
  book: Book | null;
  trades: Trade[];
  tradesReceived: boolean;
  rejectedTradeIds: number;
  candles: Candle[];
  historyLoading: boolean;
  historyError: string | null;
  historyRevision: number;
  /** Manual history retry, set only after the automatic retry failed on a live socket. */
  historyRetry: (() => void) | null;
  /** Increments on every socket open and never resets, so connection order does not depend on the clock. */
  connectionId: number;
  /** Connection each panel's data last arrived on (freshness), and when (display only). */
  bookFrom: number | null;
  tradesFrom: number | null;
  candlesFrom: number | null;
  bookAt: number | null;
  tradesAt: number | null;
  candlesAt: number | null;
  reconnects: number;
  feedError: string | null;
}
export const createMarketStore = () => createStore<MarketState>(() => ({
  markets: [], marketError: null, coin: '', connection: 'connecting',
  book: null, trades: [], tradesReceived: false, rejectedTradeIds: 0, candles: [],
  historyLoading: true, historyError: null, historyRevision: 0, historyRetry: null,
  connectionId: 0, bookFrom: null, tradesFrom: null, candlesFrom: null, bookAt: null, tradesAt: null, candlesAt: null,
  reconnects: 0, feedError: null,
}));
export type MarketStore = ReturnType<typeof createMarketStore>;
export const marketStore = createMarketStore();

export type Freshness = Pick<MarketState, 'connection' | 'connectionId'>;
/** Cleared on market switch; connectionId is deliberately kept so it keeps increasing. */
export const noPanelData = { bookFrom: null, tradesFrom: null, candlesFrom: null, bookAt: null, tradesAt: null, candlesAt: null };

/** Data is fresh only if it arrived on the current live connection. */
export const isFresh = (state: Freshness, from: number | null) =>
  state.connection === 'live' && from === state.connectionId;

// A panel is stale while it shows data that did not arrive on the current live connection:
// disconnected, or reconnected but still waiting for that channel's first message.
// Before any data arrives (initial connect, market switch) the panel is loading, not stale.
export const staleLabel = (state: Freshness, hasData: boolean, from: number | null, lastUpdate?: string) => {
  if (!hasData || isFresh(state, from)) return null;
  const label = state.connection === 'live' ? 'Stale · waiting for update'
    : state.connection === 'offline' ? 'Stale · offline' : 'Stale · reconnecting';
  return lastUpdate ? `${label} · last update ${lastUpdate}` : label;
};
