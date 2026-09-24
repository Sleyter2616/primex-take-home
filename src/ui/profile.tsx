import { Profiler, useEffect, useRef, useState, type ReactNode } from 'react';
import { metric, profiling, startRecording, stopRecording } from '../perf/metrics';

const panels = ['Header', 'ConnectionStatus', 'MarketSelector', 'MarketSummary', 'PriceChart', 'TradesTape', 'OrderBook'];
const events = ['bookMessages', 'tradeBatches', 'seriesUpdate', 'seriesSetData'];
const windowMs = 60_000;

export function profilePanel(id: string, children: ReactNode) {
  return profiling ? <Profiler id={id} onRender={() => metric(id)}>{children}</Profiler> : children;
}
export function ProfileControls() {
  const [result, setResult] = useState('Ready: wait for history, then start a 60-second window.');
  const [running, setRunning] = useState(false);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  return <aside style={{ padding: 16, overflowWrap: 'anywhere' }}>
    <button disabled={running} onClick={() => {
      const run = startRecording([...panels, ...events], windowMs);
      const visibleAtStart = document.visibilityState === 'visible';
      let visibilityChanges = 0;
      const changed = () => visibilityChanges++;
      document.addEventListener('visibilitychange', changed);
      const coin = document.querySelector<HTMLSelectElement>('#market')?.value;
      setRunning(true); setResult('Recording 60 seconds…');
      const timer = setTimeout(() => {
        stopRecording(run);
        document.removeEventListener('visibilitychange', changed);
        const report = JSON.stringify({ coin, visibleAtStart, visibilityChanges, windowMs, completedAfterMs: Math.round(performance.now() - run.started), ...run.counts });
        console.info('HL_PROFILE_RESULT', report); setResult(report); setRunning(false);
      }, windowMs);
      cleanup.current = () => {
        clearTimeout(timer); document.removeEventListener('visibilitychange', changed);
        stopRecording(run);
      };
    }}>Measure 60 seconds</button>
    <output id="hl-profile-result" style={{ display: 'block', marginTop: 8 }}>{result}</output>
  </aside>;
}
