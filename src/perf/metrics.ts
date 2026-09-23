// Dev-only counters shared by the data layer and the UI profiler. No React import, so the
// data layer can record events without depending on src/ui.
export const profiling = import.meta.env.DEV && typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('profile') === '1';

export interface Recording { started: number; ends: number; counts: Record<string, number> }
let active: Recording | null = null;

export function metric(name: string) {
  if (profiling && active && performance.now() < active.ends) active.counts[name] = (active.counts[name] ?? 0) + 1;
}

export function startRecording(names: string[], windowMs: number): Recording {
  const started = performance.now();
  active = { started, ends: started + windowMs, counts: Object.fromEntries(names.map(name => [name, 0])) };
  return active;
}

export function stopRecording(run: Recording) {
  if (active === run) active = null;
}
