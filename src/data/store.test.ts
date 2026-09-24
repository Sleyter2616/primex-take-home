import { describe, expect, it } from 'vitest';
import { isFresh, staleLabel } from './store';

const live = { connection: 'live' as const, connectedAt: 1000 };

describe('staleLabel', () => {
  it('is not stale before any data is shown, whatever the connection', () => {
    for (const connection of ['connecting', 'live', 'reconnecting', 'offline'] as const) {
      expect(staleLabel({ connection, connectedAt: 1000 }, false, null)).toBeNull();
    }
  });
  it('is not stale when the data arrived on the current live connection', () => {
    expect(staleLabel(live, true, 1000)).toBeNull();
    expect(staleLabel(live, true, 1500)).toBeNull();
  });
  it('is stale when live but the data predates the current connection', () => {
    expect(staleLabel(live, true, 999)).toBe('Stale · waiting for update');
  });
  it('names the connection state when disconnected', () => {
    expect(staleLabel({ connection: 'reconnecting', connectedAt: 1000 }, true, 1500)).toBe('Stale · reconnecting');
    expect(staleLabel({ connection: 'connecting', connectedAt: null }, true, 1500)).toBe('Stale · reconnecting');
    expect(staleLabel({ connection: 'offline', connectedAt: 1000 }, true, 1500)).toBe('Stale · offline');
  });
  it('appends the last update time when one is given', () => {
    expect(staleLabel({ connection: 'offline', connectedAt: 1000 }, true, 1500, '00:35:40 UTC'))
      .toBe('Stale · offline · last update 00:35:40 UTC');
    expect(staleLabel(live, true, 1500, '00:35:40 UTC')).toBeNull();
  });
});

describe('isFresh', () => {
  it('requires a live connection and data received since it opened', () => {
    expect(isFresh(live, 1000)).toBe(true);
    expect(isFresh(live, 999)).toBe(false);
    expect(isFresh(live, null)).toBe(false);
    expect(isFresh({ connection: 'reconnecting', connectedAt: 1000 }, 1500)).toBe(false);
  });
});
