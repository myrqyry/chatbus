import { describe, expect, it } from 'vitest';
import {
  ChatTimeline,
  createTestChatEvent,
  createTestMessageEvent,
  normalizeTwitchEventSubNotification,
  parseTwitchEventSubFrame,
  reduceChatEvents,
  reduceChatTimeline,
} from '../src/index';

const notice = (noticeType: string, messageId = 'viewer-msg', withMessage = true) => {
  const raw = {
    metadata: {
      message_id: 'delivery-' + noticeType,
      message_type: 'notification',
      message_timestamp: '2026-10-15T22:00:00Z',
      subscription_type: 'channel.chat.notification',
    },
    payload: {
      subscription: { type: 'channel.chat.notification', version: '1' },
      event: {
        broadcaster_user_id: '10', broadcaster_user_login: 'host',
        chatter_user_id: '20', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
        notice_type: noticeType, message_id: messageId,
        color: '#00FF7F', badges: [{ set_id: 'subscriber', id: '6' }],
        system_message: 'Viewer returned!',
        ...(withMessage ? {
          message: {
            text: 'hi Kappa',
            fragments: [
              { type: 'text', text: 'hi ' },
              { type: 'emote', text: 'Kappa', emote: { id: '25', format: ['static'] } },
            ],
          },
        } : {}),
      },
    },
  };
  const parsed = parseTwitchEventSubFrame(JSON.stringify(raw));
  if (!parsed) throw new Error('Bad test frame');
  return normalizeTwitchEventSubNotification(parsed);
};

const twitchMessage = (id: string, channelId = '10') =>
  createTestMessageEvent({ platform: 'twitch', channelId, messageId: id, userId: '20', username: 'viewer' });

const deleteMessage = (id: string, channelId = '10') =>
  createTestChatEvent('message-delete', {
    platform: 'twitch', channelId, id: 'delete-' + id,
    timestamp: 25, data: { messageId: id },
  });

describe('Twitch chat-notice parity', () => {
  it.each(['watch_streak', 'announcement', 'shared_chat_watch_streak', 'shared_chat_announcement'])(
    'delivers message-bearing %s as a real chat message without losing notice evidence',
    (noticeType) => {
      const event = notice(noticeType);
      expect(event).toMatchObject({
        type: 'message', id: 'viewer-msg', user: { id: '20', username: 'viewer' },
        message: {
          id: 'viewer-msg', text: 'hi Kappa',
          user: { color: '#00FF7F', badgeRefs: [{ id: 'subscriber', version: '6' }] },
        },
        data: { kind: 'chat-notification', noticeType, systemMessage: 'Viewer returned!' },
      });
      expect(event?.message?.fragments).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'emote', emote: expect.objectContaining({ id: '25' }) }),
      ]));
    },
  );

  it('does not invent viewer chat from a notice lacking a message', () => {
    const event = notice('watch_streak', 'notice-id', false);
    expect(event).toMatchObject({ type: 'system', data: { noticeType: 'watch_streak' } });
    expect(event?.message).toBeUndefined();
  });

  it('keeps optional resub messages attached to subscription events instead of triggering chat commands', () => {
    expect(notice('resub')).toMatchObject({
      type: 'subscription', message: { id: 'viewer-msg' },
      data: { noticeType: 'resub' },
    });
  });

  it('deduplicates native message IDs when a notice and a chat delivery race in either order', () => {
    const n = notice('announcement');
    if (!n) throw new Error('Missing notice');
    const ordinary = twitchMessage('viewer-msg');
    for (const events of [[n, ordinary], [ordinary, n]]) {
      const entries = reduceChatEvents(events);
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe(events[0]);
    }
    expect(reduceChatEvents([twitchMessage('viewer-msg'), twitchMessage('viewer-msg', 'other')])).toHaveLength(2);
  });

  it('buffers a moderator deletion before a notice arrives, both for incremental and batch timelines', () => {
    const n = notice('watch_streak');
    if (!n) throw new Error('Missing notice');
    const deletion = deleteMessage('viewer-msg');
    const timeline = new ChatTimeline();
    timeline.apply(deletion);
    expect(timeline.size).toBe(0);
    timeline.apply(n);
    expect(timeline.visibleEvents()).toEqual([]);
    expect(timeline.snapshot()).toMatchObject([{
      deleted: true, deletion: { reason: 'message-delete', eventId: 'delete-viewer-msg' },
      event: { message: { id: 'viewer-msg' } },
    }]);
    expect(reduceChatEvents([deletion, n])[0]?.deleted).toBe(true);
  });

  it('never applies a pending delete to another channel or platform', () => {
    const timeline = new ChatTimeline();
    timeline.apply(deleteMessage('same-id'));
    timeline.apply(twitchMessage('same-id', 'other'));
    timeline.apply(createTestMessageEvent({ platform: 'kick', channelId: '10', messageId: 'same-id' }));
    expect(timeline.visibleEvents()).toHaveLength(2);
    timeline.apply(twitchMessage('same-id'));
    expect(timeline.snapshot().filter(e => e.deleted)).toHaveLength(1);
  });

  it('does not treat an EventSub delivery ID as a missing deletion target', () => {
    const chat = twitchMessage('delivery-id');
    const deletionWithoutTarget = createTestChatEvent('message-delete', {
      platform: 'twitch', channelId: '10', id: 'delivery-id',
      data: {},
    });
    const timeline = new ChatTimeline();
    timeline.apply(chat);
    timeline.apply(deletionWithoutTarget);
    expect(timeline.visibleEvents()).toEqual([chat]);
    expect(reduceChatEvents([deletionWithoutTarget, chat])[0]?.deleted).toBe(false);
  });

  it('evicts old unseen deletions at a finite per-timeline bound', () => {
    const timeline = new ChatTimeline({ limit: 1 });
    for (const id of ['first', 'second', 'third']) timeline.apply(deleteMessage(id));
    timeline.apply(twitchMessage('first'));
    expect(timeline.snapshot()[0].deleted).toBe(false);
    timeline.apply(twitchMessage('third'));
    expect(timeline.snapshot()[0]).toMatchObject({
      deleted: true, event: { message: { id: 'third' } },
    });
  });

  it('clears pending deletion state on clear and restore, and leaves stateless reducer behavior unchanged', () => {
    const mutation = deleteMessage('future');
    const timeline = new ChatTimeline();
    timeline.apply(mutation);
    timeline.clear();
    timeline.apply(twitchMessage('future'));
    expect(timeline.visibleEvents()).toHaveLength(1);

    timeline.apply(deleteMessage('after-restore'));
    timeline.restore(timeline.snapshot());
    timeline.apply(twitchMessage('after-restore'));
    expect(timeline.visibleEvents()).toHaveLength(2);

    // This API receives only visible entries and cannot retain unseen deletions.
    const first = reduceChatTimeline([], deleteMessage('only-stateless'));
    expect(first).toEqual([]);
  });
});
