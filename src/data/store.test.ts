import { describe, expect, it } from 'vitest';
import { isFresh, staleLabel } from './store';

const live = { connection: 'live' as const, connectionId: 3 };

describe('staleLabel', () => {
  it('is not stale before any data is shown, whatever the connection', () => {
    for (const connection of ['connecting', 'live', 'reconnecting', 'offline'] as const) {
      expect(staleLabel({ connection, connectionId: 3 }, false, null)).toBeNull();
    }
  });
  it('is not stale when the data arrived on the current live connection', () => {
    expect(staleLabel(live, true, 3)).toBeNull();
  });
  it('is stale when live but the data arrived on an earlier connection', () => {
    expect(staleLabel(live, true, 2)).toBe('Stale · waiting for update');
    expect(staleLabel(live, true, null)).toBe('Stale · waiting for update');
  });
  it('names the connection state when disconnected', () => {
    expect(staleLabel({ connection: 'reconnecting', connectionId: 3 }, true, 3)).toBe('Stale · reconnecting');
    expect(staleLabel({ connection: 'connecting', connectionId: 3 }, true, 3)).toBe('Stale · reconnecting');
    expect(staleLabel({ connection: 'offline', connectionId: 3 }, true, 3)).toBe('Stale · offline');
  });
  it('appends the last update time when one is given', () => {
    expect(staleLabel({ connection: 'offline', connectionId: 3 }, true, 3, '00:35:40 UTC'))
      .toBe('Stale · offline · last update 00:35:40 UTC');
    expect(staleLabel(live, true, 3, '00:35:40 UTC')).toBeNull();
  });
});

describe('isFresh', () => {
  it('requires a live connection and data from that same connection', () => {
    expect(isFresh(live, 3)).toBe(true);
    expect(isFresh(live, 2)).toBe(false);
    expect(isFresh(live, null)).toBe(false);
    expect(isFresh({ connection: 'reconnecting', connectionId: 3 }, 3)).toBe(false);
  });
});
