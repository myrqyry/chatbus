import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../src/types/chat';
import { toSocialSignal } from '../src/social/signal';

describe('Chatbus social signal v1', () => {
  const message: ChatEvent = {
    type: 'message', platform: 'twitch', timestamp: 1500, origin: 'live',
    channelId: 'c-1', channelName: 'somewhere',
    user: { platform: 'twitch', id: 'u-1', username: 'Alice', displayName: 'alice' },
    message: {
      id: 'msg-1', platform: 'twitch', timestamp: 1500, channelId: 'c-1',
      user: { platform: 'twitch', id: 'u-1', username: 'Alice' },
      text: 'watch behind you', fragments: [{ type: 'text', text: 'watch behind you' }],
      reply: { parentMessageId: 'msg-parent', threadMessageId: 'thread-1' },
      raw: { secret: 'never include' },
    },
    raw: { authToken: 'never include' },
  };

  it('keeps attribution, clocks, and reply relationships but not raw payloads', () => {
    const out = toSocialSignal(message, { receivedAtMs: 1600, connectionId: 'twitch:somewhere' });
    expect(out).toEqual({
      schemaVersion: 1, producer: 'chatbus',
      source: {
        platform: 'twitch', channelId: 'c-1', channelName: 'somewhere',
        connectionId: 'twitch:somewhere', origin: 'live',
      },
      event: { type: 'message', id: 'msg-1', occurredAtMs: 1500, receivedAtMs: 1600 },
      actor: { platform: 'twitch', id: 'u-1', username: 'Alice', displayName: 'alice' },
      message: { id: 'msg-1', text: 'watch behind you', parentMessageId: 'msg-parent',
        threadMessageId: 'thread-1' },
    });
    expect(JSON.stringify(out)).not.toContain('never include');
  });

  it('does not invent event IDs or cross-platform identities', () => {
    const out = toSocialSignal({
      type: 'follow', platform: 'custom', timestamp: 500,
      user: { platform: 'custom', username: 'anonymous' },
    }, { receivedAtMs: 600 });
    expect(out.event.id).toBeUndefined();
    expect(out.actor).toEqual({ platform: 'custom', username: 'anonymous' });
    expect(out.source.platform).toBe('custom');
  });

  it('retains upstream correlation and monetary strings without converting them', () => {
    const out = toSocialSignal({
      type: 'donation', platform: 'youtube', timestamp: 100,
      id: 'evt-1', origin: 'replay',
      data: { source: 'streamlabs', streamlabsEventId: 'batch-5',
        amount: '2000000', currency: 'USD', count: 2, bits: 0 },
    }, { receivedAtMs: 200 });
    expect(out).toMatchObject({
      source: { platform: 'youtube', origin: 'replay', upstream: 'streamlabs' },
      event: { id: 'evt-1', type: 'donation' },
      upstreamBatchId: 'batch-5',
      measurements: { amount: '2000000', currency: 'USD', count: 2, bits: 0 },
    });
  });

  it('rejects impossible receipt/event times rather than creating misleading evidence', () => {
    expect(() => toSocialSignal({ ...message, timestamp: Number.NaN },
      { receivedAtMs: 2000 })).toThrow('timestamp');
    expect(() => toSocialSignal(message, { receivedAtMs: -1 })).toThrow('receivedAtMs');
  });
});
