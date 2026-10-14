import { describe, expect, it } from 'vitest';
import { normalizeStreamlabsPayload } from '../src/platforms/streamlabs/normalize';

describe('Streamlabs payload normalization', () => {
  const opts = { timestamp: 12345, channelName: 'example' };

  it('expands multi-message donations with separate stable IDs and preserved decimal strings', () => {
    const { events, unknown } = normalizeStreamlabsPayload([{
      type: 'donation', event_id: 'batch-1', message: [
        { _id: 'a', name: 'One', amount: '4.20', currency: 'USD', message: 'hi' },
        { _id: 'b', name: 'Two', amount: '5.55', currency: 'EUR' },
      ],
    }], opts);
    expect(unknown).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.id)).toEqual([
      'streamlabs:unknown:donation:a', 'streamlabs:unknown:donation:b',
    ]);
    expect(events[0]).toMatchObject({
      type: 'donation', platform: 'custom', channelName: 'example',
      user: { username: 'One' },
      data: { source: 'streamlabs', sourceType: 'donation', amount: '4.20',
        currency: 'USD', streamlabsEventId: 'batch-1' },
    });
    expect(events[0].raw).toBeDefined();
  });

  it('uses envelope + item index when messages have no individual IDs', () => {
    const { events } = normalizeStreamlabsPayload([{
      type: 'follow', for: 'twitch_account', event_id: 'envelope',
      message: [{ name: 'alice' }, { name: 'bob' }],
    }], opts);
    expect(events.map(e => e.id)).toEqual([
      'streamlabs:twitch_account:follow:envelope:0',
      'streamlabs:twitch_account:follow:envelope:1',
    ]);
    expect(events[0].platform).toBe('twitch');
  });

  it('leaves ID empty if neither message nor envelope has a reliable ID', () => {
    const { events } = normalizeStreamlabsPayload([{
      type: 'follow', for: 'youtube_account', message: [{ name: 'Alice' }],
    }], opts);
    expect(events[0].id).toBeUndefined();
    expect(events[0].platform).toBe('youtube');
  });

  it('handles gifted subscriptions and the source platform separately', () => {
    const { events } = normalizeStreamlabsPayload([{
      type: 'subscription', for: 'twitch_account',
      message: [{ _id: 'gift-id', name: 'gifted', sub_type: 'subgift', months: '1' }],
    }, {
      type: 'subscription', for: 'twitch_account',
      message: [{ _id: 'regular-id', name: 'regular', sub_type: 'resub' }],
    }], opts);
    expect(events.map(e => e.type)).toEqual(['gift-subscription', 'subscription']);
    expect(events[0].platform).toBe('twitch');
  });

  it('does not mix alert playback or labels with social events', () => {
    const { events, auxiliary } = normalizeStreamlabsPayload([{
      type: 'alertPlaying', message: { type: 'follow', isTest: true },
    }, {
      type: 'streamlabels.underlying', message: { count: 4 },
    }, {
      type: 'muteVolume', message: { muted: true },
    }, {
      type: 'donationDelete', message: { id: 'old' },
    }], opts);
    expect(events).toEqual([]);
    expect(auxiliary.map(a => a.kind)).toEqual([
      'alert-playing', 'streamlabels', 'volume', 'donation-delete',
    ]);
  });

  it('preserves unknown types and malformed items instead of mislabeling them', () => {
    const out = normalizeStreamlabsPayload([
      { type: 'host', message: [{ name: 'x' }] },
      { type: 'follow', message: { name: 'not a batch' } },
      { type: 'raid', message: [null, { name: 'raider', raiders: 12 }] },
    ], opts);
    expect(out.unknown.map(a => a.reason)).toEqual([
      'unsupported-type', 'invalid-message', 'invalid-message',
    ]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].type).toBe('raid');
  });

  it('rejects invalid JSON while accepting a string containing a valid array', () => {
    expect(normalizeStreamlabsPayload('oops').unknown[0].reason).toBe('invalid-envelope');
    expect(normalizeStreamlabsPayload(JSON.stringify([
      { type: 'follow', message: [{ _id: 'id-1', name: 'test' }] },
    ]), opts).events).toHaveLength(1);
  });

  it('preserves YouTube superchat units without turning them into dollars', () => {
    const { events } = normalizeStreamlabsPayload([{
      type: 'superchat', for: 'youtube_account',
      message: [{ _id: 'id-1', amount: '2000000', displayString: '$2.00' }],
    }], opts);
    expect(events[0]).toMatchObject({
      type: 'donation', platform: 'youtube',
      data: { amount: '2000000', formattedAmount: '$2.00' },
    });
  });
});
