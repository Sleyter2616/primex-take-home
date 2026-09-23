import { Profiler, useEffect, useRef, useState, type ReactNode } from 'react';

const enabled = import.meta.env.DEV && typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('profile') === '1';
const panels = ['Header/ConnectionStatus', 'MarketSelector', 'MarketSummary', 'PriceChart', 'TradesTape', 'OrderBook'];
let active: { started: number; ends: number; counts: Record<string, number> } | null = null;
export function metric(name: string) {
  if (enabled && active && performance.now() < active.ends) active.counts[name] = (active.counts[name] ?? 0) + 1;
}
export function profilePanel(id: string, children: ReactNode) {
  return enabled ? <Profiler id={id} onRender={() => metric(id)}>{children}</Profiler> : children;
}
export function ProfileControls() {
  const [result, setResult] = useState('Ready: wait for history, then start a 60-second window.');
  const [running, setRunning] = useState(false);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  if (!enabled) return null;
  return <aside style={{ padding: 16, overflowWrap: 'anywhere' }}>
    <button disabled={running} onClick={() => {
      const started = performance.now();
      const run = { started, ends: started + 60_000,
        counts: Object.fromEntries([...panels, 'bookMessages', 'tradeBatches', 'seriesUpdate', 'seriesSetData'].map(id => [id, 0])) };
      active = run;
      const visibleAtStart = document.visibilityState === 'visible';
      let visibilityChanges = 0;
      const changed = () => visibilityChanges++;
      document.addEventListener('visibilitychange', changed);
      const coin = document.querySelector<HTMLSelectElement>('#market')?.value;
      setRunning(true); setResult('Recording 60 seconds…');
      const timer = setTimeout(() => {
        if (active === run) active = null;
        document.removeEventListener('visibilitychange', changed);
        const report = JSON.stringify({ coin, visibleAtStart, visibilityChanges, windowMs: 60_000, completedAfterMs: Math.round(performance.now() - started), ...run.counts });
        console.info('HL_PROFILE_RESULT', report); setResult(report); setRunning(false);
      }, 60_000);
      cleanup.current = () => {
        clearTimeout(timer); document.removeEventListener('visibilitychange', changed);
        if (active === run) active = null;
      };
    }}>Measure 60 seconds</button>
    <output id="hl-profile-result" style={{ display: 'block', marginTop: 8 }}>{result}</output>
  </aside>;
}
