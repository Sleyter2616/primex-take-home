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
  reconnects: number;
  feedError: string | null;
}
export const createMarketStore = () => createStore<MarketState>(() => ({
  markets: [], marketError: null, coin: '', connection: 'connecting',
  book: null, trades: [], tradesReceived: false, rejectedTradeIds: 0, candles: [],
  historyLoading: true, historyError: null, historyRevision: 0,
  reconnects: 0, feedError: null,
}));
export type MarketStore = ReturnType<typeof createMarketStore>;
export const marketStore = createMarketStore();

// A panel is stale only while it shows retained data from a connection that is not live.
// Before the first data arrives (initial connect, market switch) the panel is loading, not stale.
export const staleLabel = (connection: Connection, hasData: boolean) =>
  !hasData || connection === 'live' ? null : connection === 'offline' ? 'Stale · offline' : 'Stale · reconnecting';
