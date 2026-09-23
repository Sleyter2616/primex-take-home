import { metric } from '../perf/metrics';
import { fetchHistory, WS_URL } from './api';
import { mergeCandles, mergeTrades, parseBook, parseCandles, parseTrades, record,
  type Book, type Candle, type Trade } from './types';
import type { MarketStore, MarketState } from './store';

export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
}
interface Dependencies {
  socket: () => SocketLike;
  history: typeof fetchHistory;
  frame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  random: () => number;
  networkEvents: EventTarget | null;
  warn: (message: string) => void;
}
const defaults: Dependencies = {
  socket: () => new WebSocket(WS_URL) as unknown as SocketLike,
  history: fetchHistory,
  frame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
  random: Math.random,
  networkEvents: typeof window === 'undefined' ? null : window,
  warn: message => console.warn(message),
};

/** One selected-market session. Stop invalidates every socket, timer and REST callback. */
export class MarketFeed {
  private deps: Dependencies;
  private active = false;
  private generation = 0;
  private socket: SocketLike | null = null;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private historyAbort?: AbortController;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private historyRetryTimer?: ReturnType<typeof setTimeout>;
  private offline = false;
  private failures = 0;
  private lastMessage = 0;
  private frameId: number | null = null;
  private pendingBook: Book | null = null;
  private pendingTrades: Trade[] = [];
  private pendingCandles: Candle[] = [];
  private sawTrades = false;
  private liveDuringHistory: Candle[] | null = null;

  constructor(private store: MarketStore, private coin: string, deps: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...deps };
  }

  private onOffline = () => {
    this.offline = true;
    this.reconnect(true);
  };

  private onOnline = () => {
    this.offline = false;
    this.failures = 0;
    this.reconnect(true);
  };

  start() {
    if (this.active) return;
    this.active = true;
    this.offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    this.deps.networkEvents?.addEventListener('offline', this.onOffline);
    this.deps.networkEvents?.addEventListener('online', this.onOnline);
    this.store.setState({ coin: this.coin, connection: 'connecting', book: null,
      trades: [], tradesReceived: false, rejectedTradeIds: 0, candles: [], historyLoading: true,
      historyError: null, historyRevision: 0, reconnects: 0, feedError: null });
    this.connect();
  }

  stop() {
    this.active = false;
    this.deps.networkEvents?.removeEventListener('offline', this.onOffline);
    this.deps.networkEvents?.removeEventListener('online', this.onOnline);
    this.generation++;
    this.cleanConnection();
    clearTimeout(this.retryTimer);
    this.clearPending();
  }

  dispose() { this.stop(); }

  private subscriptions() {
    return [ { type: 'l2Book', coin: this.coin }, { type: 'trades', coin: this.coin },
      { type: 'candle', coin: this.coin, interval: '1m' } ];
  }

  private cleanConnection() {
    clearInterval(this.heartbeat);
    clearTimeout(this.connectionTimer);
    clearTimeout(this.historyTimer);
    clearTimeout(this.historyRetryTimer);
    this.historyAbort?.abort();
    this.liveDuringHistory = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (socket.readyState === 1) {
        for (const subscription of this.subscriptions()) {
          try { socket.send(JSON.stringify({ method: 'unsubscribe', subscription })); } catch { /* closing */ }
        }
      }
      socket.close();
    }
  }

  private clearPending() {
    if (this.frameId !== null) this.deps.cancelFrame(this.frameId);
    this.frameId = null;
    this.pendingBook = null;
    this.pendingTrades = [];
    this.pendingCandles = [];
    this.sawTrades = false;
  }

  private connect() {
    if (!this.active || this.store.getState().coin !== this.coin) return;
    const generation = ++this.generation;
    const current = () => this.active && this.generation === generation && this.store.getState().coin === this.coin;
    let socket: SocketLike;
    try { socket = this.deps.socket(); } catch { this.reconnect(); return; }
    this.socket = socket;
    this.connectionTimer = setTimeout(() => { if (current()) this.reconnect(); }, 10_000);
    socket.onopen = () => {
      if (!current()) return;
      clearTimeout(this.connectionTimer);
      this.offline = false;
      this.lastMessage = Date.now();
      this.store.setState({ connection: 'live', feedError: null });
      try {
        for (const subscription of this.subscriptions()) {
          socket.send(JSON.stringify({ method: 'subscribe', subscription }));
        }
      } catch { this.reconnect(); return; }
      this.loadHistory(generation);
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        if (Date.now() - this.lastMessage > 35_000) { this.reconnect(); return; }
        try { socket.send(JSON.stringify({ method: 'ping' })); } catch { this.reconnect(); }
      }, 15_000);
    };
    socket.onclose = socket.onerror = () => { if (current()) this.reconnect(); };
    socket.onmessage = event => {
      if (!current()) return;
      this.lastMessage = Date.now();
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!record(message)) return;
      if (message.channel === 'error') {
        this.store.setState({ feedError: 'Testnet rejected a subscription. Reconnecting…' });
        this.reconnect();
        return;
      }
      if (import.meta.env.DEV) {
        if (message.channel === 'l2Book') metric('bookMessages');
        if (message.channel === 'trades') metric('tradeBatches');
      }
      if (message.channel === 'l2Book') {
        const book = parseBook(message.data, this.coin);
        const previousTime = this.pendingBook?.time ?? this.store.getState().book?.time ?? 0;
        if (book && book.time >= previousTime) { this.pendingBook = book; this.failures = 0; }
      } else if (message.channel === 'trades') {
        let rejected = 0;
        const trades = parseTrades(message.data, this.coin, () => rejected++);
        if (rejected) {
          this.store.setState(state => ({ rejectedTradeIds: state.rejectedTradeIds + rejected }));
          this.deps.warn(`[${this.coin}] Rejected ${rejected} trades: tid must be a safe integer.`);
        }
        this.pendingTrades = mergeTrades(this.pendingTrades, trades);
        this.sawTrades = true;
      } else if (message.channel === 'candle') {
        const candles = parseCandles(message.data, this.coin);
        this.pendingCandles = mergeCandles(this.pendingCandles, candles);
        if (this.liveDuringHistory !== null) {
          this.liveDuringHistory = mergeCandles(this.liveDuringHistory, candles);
        }
      } else return;
      this.scheduleFlush();
    };
  }

  private reconnect(immediate = false) {
    if (!this.active || this.store.getState().coin !== this.coin) return;
    this.flushPending();
    ++this.generation;
    this.cleanConnection();
    this.clearPending();
    clearTimeout(this.retryTimer);
    this.store.setState(state => ({ connection: this.offline ? 'offline' : 'reconnecting',
      reconnects: state.reconnects + 1, historyLoading: false }));
    if (immediate) { this.connect(); return; }
    const delay = Math.min(1000 * 2 ** this.failures++ + this.deps.random() * 500, 15_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private async loadHistory(generation: number, retried = false) {
    this.historyAbort?.abort();
    const abort = this.historyAbort = new AbortController();
    this.liveDuringHistory = [];
    this.store.setState({ historyLoading: true, historyError: null });
    clearTimeout(this.historyTimer);
    const timeout = this.historyTimer = setTimeout(() => abort.abort(), 12_000);
    try {
      const history = await this.deps.history(this.coin, abort.signal);
      if (!this.active || generation !== this.generation || this.store.getState().coin !== this.coin) return;
      // Include live candles received since the request began, even if already flushed.
      const merged = mergeCandles(history, this.liveDuringHistory ?? []);
      const candles = mergeCandles(this.store.getState().candles, merged);
      this.store.setState(state => ({ candles, historyLoading: false,
        historyRevision: state.historyRevision + 1 }));
    } catch {
      if (this.active && generation === this.generation && this.store.getState().coin === this.coin) {
        this.store.setState({ historyLoading: false,
          historyError: retried ? 'History unavailable. Live candles continue; history retries on reconnection.'
            : 'History unavailable. Live candles continue; retrying in 5 seconds.' });
        if (!retried && this.socket?.readyState === 1) {
          this.historyRetryTimer = setTimeout(() => {
            if (this.active && this.generation === generation && this.store.getState().coin === this.coin
                && this.socket?.readyState === 1) void this.loadHistory(generation, true);
          }, 5_000);
        }
      }
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) this.liveDuringHistory = null;
    }
  }

  private scheduleFlush() {
    if (this.frameId !== null) return;
    const generation = this.generation;
    this.frameId = this.deps.frame(() => {
      if (this.generation === generation) this.flushPending();
    });
  }

  private flushPending() {
    if (this.frameId !== null) this.deps.cancelFrame(this.frameId);
    this.frameId = null;
    if (!this.active || this.store.getState().coin !== this.coin) return;
    const current = this.store.getState();
    const patch: Partial<MarketState> = {};
    if (this.pendingBook) patch.book = this.pendingBook;
    if (this.sawTrades) {
      patch.tradesReceived = true;
      if (this.pendingTrades.length) patch.trades = mergeTrades(current.trades, this.pendingTrades);
    }
    if (this.pendingCandles.length) patch.candles = mergeCandles(current.candles, this.pendingCandles);
    this.pendingBook = null;
    this.pendingTrades = [];
    this.pendingCandles = [];
    this.sawTrades = false;
    if (Object.keys(patch).length) this.store.setState(patch);
  }
}
