import { memo, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { fetchMarkets } from '../data/api';
import { MarketFeed } from '../data/feed';
import { marketStore, staleLabel, type MarketState } from '../data/store';
import type { Level, Trade } from '../data/types';
import { PriceChart } from './Chart';
import { profiling } from '../perf/metrics';
import { ProfileControls, profilePanel } from './profile';
import { price, size, time } from './format';

const updatedAt = (state: MarketState) => state.lastUpdateAt ? `${time(state.lastUpdateAt)} UTC` : undefined;

function FeedLifecycle() {
  const coin = useStore(marketStore, state => state.coin);
  useEffect(() => {
    if (!coin) return;
    const feed = new MarketFeed(marketStore, coin);
    feed.start();
    return () => feed.dispose();
  }, [coin]);
  return null;
}

function MarketSelector() {
  const markets = useStore(marketStore, state => state.markets);
  const coin = useStore(marketStore, state => state.coin);
  const error = useStore(marketStore, state => state.marketError);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const timeout = setTimeout(() => abort.abort(), 12_000);
    marketStore.setState({ marketError: null });
    fetchMarkets(abort.signal).then(markets => {
      if (active) marketStore.setState({ markets, coin: markets[0].name });
    }).catch(error => {
      if (active) marketStore.setState({ marketError: error instanceof Error ? error.message : 'Unable to load markets' });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); abort.abort(); };
  }, [attempt]);
  return <><div className="market-picker">
    <span className="coin-icon" aria-hidden="true">{coin ? coin.slice(0,1) : '·'}</span>
    <div><label htmlFor="market">Perpetual market</label>
      <select id="market" value={coin} disabled={!markets.length}
        onChange={event => {
          // Reset synchronously so the new label never paints beside the old market's data.
          marketStore.setState({ coin: event.target.value, book: null, trades: [], candles: [],
            tradesReceived: false, historyLoading: true, historyError: null, historyRetry: null, lastUpdateAt: null, connection: 'connecting' });
        }}>
        {!markets.length && <option value="">{error ? 'Unavailable' : 'Loading…'}</option>}
        {markets.map(market => <option key={market.name} value={market.name}>{market.name} / USD</option>)}
      </select>
    </div>
    <span className="contract-badge">PERP</span>
  </div>
  {error && <div className="market-error" role="alert" title={error}>Could not load the market list. This does not retry automatically. <button onClick={() => setAttempt(n => n + 1)}>Retry</button></div>}
  </>;
}

function ConnectionStatus() {
  const connection = useStore(marketStore, state => state.connection);
  const error = useStore(marketStore, state => state.feedError);
  const coin = useStore(marketStore, state => state.coin);
  const labels = { live: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting automatically', offline: 'Offline · will reconnect' };
  return <div className={`connection ${connection}`} role="status" title={error ?? 'Hyperliquid testnet WebSocket'}>
    <span className="status-dot" />{error ? `Error · ${error}` : coin ? labels[connection] : 'Waiting for markets'}
  </div>;
}

function MarketSummary() {
  // Short label here: the time is shown in the chart caption and order book footer.
  const stale = useStore(marketStore, state => staleLabel(state.connection, state.book !== null));
  const mid = useStore(marketStore, state => state.book?.bids[0] && state.book?.asks[0]
    ? (state.book.bids[0].price + state.book.asks[0].price) / 2 : null);
  const bestBid = useStore(marketStore, state => state.book?.bids[0]?.price);
  const bestAsk = useStore(marketStore, state => state.book?.asks[0]?.price);
  return <div className={`market-stats ${stale ? 'stale' : ''}`} aria-label={stale ? `Market summary, ${stale}` : 'Market summary'}>
    <div className="stat primary"><span>{stale ?? 'Mid price'}</span><strong>{mid ? price(mid) : '—'}</strong></div>
    <div className="stat"><span>Best bid</span><strong className="buy">{bestBid ? price(bestBid) : '—'}</strong></div>
    <div className="stat"><span>Best ask</span><strong className="sell">{bestAsk ? price(bestAsk) : '—'}</strong></div>
    <div className="stat"><span>Spread</span><strong>{bestBid && bestAsk ? price(bestAsk - bestBid) : '—'} <small>USD</small></strong></div>
  </div>;
}

const BookRow = memo(function BookRow({ level, depth, decimals, side }: {
  level: Level; depth: number; decimals: number; side: 'bid' | 'ask';
}) {
  return <div className={`book-row ${side}`} role="row">
    <span className="depth-bar" style={{ width: `${depth}%` }} aria-hidden="true" />
    <span role="cell" className={side === 'bid' ? 'buy' : 'sell'}>{price(level.price)}</span>
    <span role="cell">{size(level.size, decimals)}</span>
    <span role="cell" className="cumulative">{size(level.cumulative, decimals)}</span>
  </div>;
}, (previous, next) => previous.side === next.side && previous.decimals === next.decimals
  && previous.depth === next.depth && previous.level.price === next.level.price
  && previous.level.size === next.level.size && previous.level.cumulative === next.level.cumulative);

function OrderBook() {
  const book = useStore(marketStore, state => state.book);
  const coin = useStore(marketStore, state => state.coin);
  const decimals = useStore(marketStore, state => state.markets.find(market => market.name === state.coin)?.sizeDecimals ?? 5);
  const stale = useStore(marketStore, state => staleLabel(state.connection, state.book !== null, updatedAt(state)));
  const max = Math.max(book?.bids.at(-1)?.cumulative ?? 0, book?.asks.at(-1)?.cumulative ?? 0, 0.000001);
  const spread = book?.bids[0] && book?.asks[0] ? book.asks[0].price - book.bids[0].price : null;
  return <section className="panel book-panel" aria-label="Live order book">
    <div className="panel-heading"><h2>Order book <span className="muted">/ {coin || '—'}</span></h2><span className="panel-meta">20 levels / side</span></div>
    <div className="book-table" role="table" aria-label={`${coin} order book`}>
      <div className="book-columns" role="row"><span role="columnheader">Price (USD)</span>
        <span role="columnheader">Size ({coin || '—'})</span><span role="columnheader">Total</span></div>
      {!book ? <div className="panel-empty">Waiting for order book…</div> : <div className={stale ? 'stale' : ''}>
        <div className="book-side asks" role="rowgroup">
          {!book.asks.length && <div className="side-empty">No asks</div>}
          {[...book.asks].reverse().map(level => <BookRow key={level.price} level={level} decimals={decimals} side="ask" depth={level.cumulative / max * 100} />)}
        </div>
        <div className="spread-row"><span>Spread</span><strong>{spread === null ? '—' : price(spread)}</strong>
          <span>{spread !== null && book.bids[0] ? `${(spread / book.bids[0].price * 100).toFixed(3)}%` : '—'}</span></div>
        <div className="book-side bids" role="rowgroup">
          {!book.bids.length && <div className="side-empty">No bids</div>}
          {book.bids.map(level => <BookRow key={level.price} level={level} decimals={decimals} side="bid" depth={level.cumulative / max * 100} />)}
        </div>
      </div>}
    </div>
    <div className="panel-foot"><span>{stale ?? 'Cumulative size depth'}</span><span>USD</span></div>
  </section>;
}

const TradeRow = memo(function TradeRow({ trade, decimals }: { trade: Trade; decimals: number }) {
  return <tr><td className={trade.side}>{price(trade.price)}</td><td>{size(trade.size, decimals)}</td>
    <td><span className={`side-label ${trade.side}`}>{trade.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
    <td className="muted">{time(trade.time)}</td></tr>;
});

function TradesTape() {
  const trades = useStore(marketStore, state => state.trades);
  const received = useStore(marketStore, state => state.tradesReceived);
  const coin = useStore(marketStore, state => state.coin);
  const decimals = useStore(marketStore, state => state.markets.find(market => market.name === state.coin)?.sizeDecimals ?? 5);
  const stale = useStore(marketStore, state => staleLabel(state.connection, state.trades.length > 0));
  return <section className="panel trades-panel" aria-label="Recent trades">
    <div className="panel-heading"><h2>Recent trades <span className="muted">/ {coin || '—'}</span> <span className="count">{trades.length}</span></h2>
      <span className="panel-meta">{stale ?? 'Latest 50 · testnet'}</span></div>
    <div className={`trades-scroll ${stale ? 'stale' : ''}`}>
      <table><thead><tr><th>Price (USD)</th><th>Size ({coin || '—'})</th><th>Side</th><th>Time (UTC)</th></tr></thead>
        <tbody>{trades.map(trade => <TradeRow key={trade.id} trade={trade} decimals={decimals} />)}</tbody></table>
      {!trades.length && <div className="panel-empty">{received ? 'No recent trades. Listening for the next execution.' : 'Waiting for trade feed…'}</div>}
    </div>
  </section>;
}

function FooterClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <span className="clock">{time(now)} UTC</span>;
}

export function App() {
  return <div className="terminal">
    <FeedLifecycle />
    {profiling && <ProfileControls />}
    {profilePanel('Header', <header className="topbar"><a className="brand" href="/" aria-label="Market terminal home"><span className="brand-mark">≋</span> PERP<span className="brand-divider">/</span><span className="brand-sub">TERMINAL</span></a>
      <div className="topbar-right"><span className="network-tag">TESTNET</span><a href="https://app.hyperliquid-testnet.xyz/trade" target="_blank" rel="noreferrer">Hyperliquid ↗</a></div>
    </header>)}
    <main>
      <div className="workspace-heading"><div><span className="eyebrow">MARKET OVERVIEW</span><h1>A live view of the market.</h1></div>
        {profilePanel('ConnectionStatus', <ConnectionStatus />)}</div>
      <div className="market-bar">{profilePanel('MarketSelector', <MarketSelector />)}{profilePanel('MarketSummary', <MarketSummary />)}</div>
      <div className="workspace"><div className="main-column">{profilePanel('PriceChart', <PriceChart />)}{profilePanel('TradesTape', <TradesTape />)}</div>{profilePanel('OrderBook', <OrderBook />)}</div>
    </main>
    <footer><div><span className="footer-dot" />Hyperliquid testnet <span className="footer-divider">/</span> Market data only. No trading.</div><FooterClock /></footer>
  </div>;
}
