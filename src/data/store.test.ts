import { describe, expect, it } from 'vitest';
import { staleLabel } from './store';

describe('staleLabel', () => {
  it('is not stale while live or before any data is shown', () => {
    expect(staleLabel('live', true)).toBeNull();
    expect(staleLabel('connecting', false)).toBeNull();
    expect(staleLabel('reconnecting', false)).toBeNull();
    expect(staleLabel('offline', false)).toBeNull();
  });
  it('names the connection state when retained data is shown', () => {
    expect(staleLabel('reconnecting', true)).toBe('Stale · reconnecting');
    expect(staleLabel('connecting', true)).toBe('Stale · reconnecting');
    expect(staleLabel('offline', true)).toBe('Stale · offline');
  });
  it('appends the last update time when one is known', () => {
    expect(staleLabel('offline', true, '00:35:40 UTC')).toBe('Stale · offline · last update 00:35:40 UTC');
    expect(staleLabel('live', true, '00:35:40 UTC')).toBeNull();
  });
});
