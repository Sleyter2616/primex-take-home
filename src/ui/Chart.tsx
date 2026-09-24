import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { CandlestickSeries, ColorType, createChart, CrosshairMode,
  type CandlestickData, type UTCTimestamp } from 'lightweight-charts';
import { metric } from '../perf/metrics';
import { isFresh, marketStore, staleLabel } from '../data/store';
import { time } from './format';
import type { Candle } from '../data/types';

const bar = (candle: Candle): CandlestickData => ({ ...candle, time: candle.time as UTCTimestamp });

export function PriceChart() {
  const stale = useStore(marketStore, state => staleLabel(state, state.candles.length > 0, state.candlesAt,
    state.candlesAt ? `${time(state.candlesAt)} UTC` : undefined));
  // Claim the book and trades are live only once both delivered on the current connection.
  const live = useStore(marketStore, state => isFresh(state, state.bookAt) && isFresh(state, state.tradesAt));
  const retry = useStore(marketStore, state => state.historyRetry);
  const container = useRef<HTMLDivElement>(null);
  const loading = useStore(marketStore, state => state.historyLoading);
  const error = useStore(marketStore, state => state.historyError);
  const empty = useStore(marketStore, state => state.candles.length === 0);
  const coin = useStore(marketStore, state => state.coin);

  useEffect(() => {
    const chart = createChart(container.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#11171b' },
        textColor: '#82929a', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
        attributionLogo: true },
      grid: { vertLines: { color: '#1c252b' }, horzLines: { color: '#1c252b' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#263037', scaleMargins: { top: 0.12, bottom: 0.1 } },
      timeScale: { borderColor: '#263037', timeVisible: true, secondsVisible: false, rightOffset: 5 },
      localization: { locale: 'en-US' },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#7bddc1', downColor: '#f18c91', borderVisible: false,
      wickUpColor: '#7bddc1', wickDownColor: '#f18c91',
    });
    let lastCoin = '', revision = -1, previous: Candle[] = [];
    let fitted = false;
    const update = (state: ReturnType<typeof marketStore.getState>) => {
      if (state.coin !== lastCoin) {
        lastCoin = state.coin; previous = []; fitted = false; revision = -1;
        if (import.meta.env.DEV) metric('seriesSetData');
        series.setData([]);
        const sizeDecimals = state.markets.find(market => market.name === state.coin)?.sizeDecimals ?? 0;
        const precision = Math.max(2, 6 - sizeDecimals);
        series.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
      }
      if (state.candles === previous) return;
      const historyChanged = state.historyRevision !== revision;
      const windowMoved = previous.length > 0 && state.candles[0]?.time !== previous[0].time;
      if (historyChanged || !previous.length || windowMoved) {
        if (import.meta.env.DEV) metric('seriesSetData');
        series.setData(state.candles.map(bar));
      } else {
        // Existing bars are immutable: only changed/new bars go to the chart API.
        const old = new Map(previous.map(candle => [candle.time, candle]));
        const previousLastTime = previous[previous.length - 1]?.time ?? 0;
        for (const candle of state.candles) {
          if (old.get(candle.time) !== candle) {
            if (import.meta.env.DEV) metric('seriesUpdate');
            series.update(bar(candle), candle.time < previousLastTime);
          }
        }
      }
      if (!fitted && state.candles.length > 1 && !state.historyLoading) {
        chart.timeScale().fitContent(); fitted = true;
      }
      revision = state.historyRevision;
      previous = state.candles;
    };
    update(marketStore.getState());
    const unsubscribe = marketStore.subscribe(update);
    return () => { unsubscribe(); chart.remove(); };
  }, []);

  return <section className="panel chart-panel" aria-label={`${coin} price chart`}>
    <div className="panel-heading"><h2>Price chart <span className="muted">/ {coin || '—'}</span></h2>
      <div className="chart-tools"><span className="interval">1m</span><span>Candles</span><span>UTC</span></div>
    </div>
    <div className="chart-wrap">
      <div className="chart-canvas" ref={container} />
      {empty && <div className="chart-empty">{!coin ? 'Waiting for market list' : loading ? 'Loading candle history…' : error ? 'No candle history' : 'Waiting for the first candle'}</div>}
      {error && <div className="chart-notice" role="alert">
        <span>{error}{live && ' Order book and trades are live.'}</span>
        {retry && <button onClick={retry}>Retry</button>}
      </div>}
    </div>
    <div className={`chart-caption ${stale ? 'stale' : ''}`}>
      <span>{stale ?? (loading && !empty ? 'Refreshing history… live updates continue.' : 'Scroll to zoom · drag to explore')}</span>
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
    </div>
  </section>;
}
