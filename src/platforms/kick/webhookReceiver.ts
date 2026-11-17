import type { ChatConnectionState, ChatEvent } from '../../types/chat';
import type { EmoteSet } from '../../types/emotes';
import { verifyKickChatWebhook, type VerifiedKickChatDelivery } from './webhook';

const MAX_BODY_BYTES = 256 * 1024;

export interface KickWebhookRegistration {
  subscriptionId: string;
  broadcasterUserId: number;
  /** Host-authorized relay target. Not inferred from incoming chat content. */
  target: string;
}

export interface KickWebhookReceiverOptions {
  subscriptions: readonly KickWebhookRegistration[];
  getPublicKey: () => Promise<string>;
  /** Atomically persist a new verified delivery and return true; false for an existing ID.
   * Must be durable across process restarts. Do not fan out from inside this function. */
  recordDelivery: (delivery: VerifiedKickChatDelivery) => Promise<boolean>;
  getEmotes?: (target: string) => EmoteSet;
  now?: () => number;
  maxAgeMs?: number;
  futureSkewMs?: number;
}

interface Listener {
  onEvent(event: ChatEvent): void;
  onStateChange(state: ChatConnectionState): void;
  onError(error: Error): void;
}
export interface KickWebhookReceiver {
  /** Host mounts this on its dedicated webhook route and enforces transport timeouts. */
  handle(request: Request): Promise<Response>;
  /** Host must authenticate/authorize the relay client before connecting it. */
  connect(target: string, callbacks: Listener): { close(): void };
  close(): void;
}

const normalizeTarget = (value: string) => value.trim().toLowerCase();

export function createKickWebhookReceiver(options: KickWebhookReceiverOptions): KickWebhookReceiver {
  const registrations = new Map<string, KickWebhookRegistration>();
  const targets = new Map<string, number>();
  const listeners = new Map<string, Set<Listener>>();
  const now = options.now ?? Date.now;
  const maxAge = options.maxAgeMs ?? 300_000;
  const futureSkew = options.futureSkewMs ?? 30_000;
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0 || !Number.isSafeInteger(futureSkew) || futureSkew < 0) {
    throw new Error('Invalid webhook freshness policy');
  }
  for (const registration of options.subscriptions) {
    const target = normalizeTarget(registration.target);
    if (!target || !registration.subscriptionId || registrations.has(registration.subscriptionId) ||
        !Number.isSafeInteger(registration.broadcasterUserId) || registration.broadcasterUserId <= 0 ||
        (targets.has(target) && targets.get(target) !== registration.broadcasterUserId)) {
      throw new Error('Invalid or conflicting Kick webhook registration');
    }
    registrations.set(registration.subscriptionId, { ...registration, target });
    targets.set(target, registration.broadcasterUserId);
  }
  let closed = false;
  const response = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  const fresh = (time: number) => {
    const age = now() - time;
    return Number.isFinite(age) && age <= maxAge && age >= -futureSkew;
  };
  const report = (listener: Listener, error: unknown) => {
    try { listener.onError(error instanceof Error ? error : new Error('Webhook listener failed')); } catch { /* isolate listener */ }
  };

  return {
    async handle(request) {
      if (closed) return response(503);
      if (request.method !== 'POST') return response(405);
      const registration = registrations.get(request.headers.get('Kick-Event-Subscription-Id') ?? '');
      const time = Date.parse(request.headers.get('Kick-Event-Message-Timestamp') ?? '');
      if (!registration || !Number.isFinite(time) || !fresh(time)) return response(401);
      const length = request.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return response(413);
      if (!request.body) return response(400);
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            void reader.cancel().catch(() => {});
            return response(413);
          }
          chunks.push(value);
        }
      } catch { return response(400); }
      finally { reader.releaseLock(); }
      let key: string;
      try { key = await options.getPublicKey(); }
      catch { return response(503); }
      let verified: VerifiedKickChatDelivery;
      try {
        verified = verifyKickChatWebhook({
          body: Buffer.concat(chunks, size),
          headers: request.headers, publicKey: key,
          subscriptionId: registration.subscriptionId,
          broadcasterUserId: registration.broadcasterUserId,
          emotes: options.getEmotes?.(registration.target),
        });
      } catch { return response(401); }
      if (!fresh(verified.deliveredAt)) return response(401);
      if (closed || request.signal.aborted) return response(503);
      let inserted: boolean;
      try { inserted = await options.recordDelivery(verified); }
      catch { return response(503); }
      // Persistence precedes live delivery. Duplicate retries are acknowledged,
      // never dispatched a second time. Live fanout is not a durable outbox.
      if (inserted && !closed) {
        const group = listeners.get(registration.target);
        for (const listener of [...(group ?? [])]) {
          if (!group?.has(listener)) continue;
          try { listener.onEvent(verified.event); } catch (error) { report(listener, error); }
        }
      }
      return response(204);
    },
    connect(target, callbacks) {
      if (closed) throw new Error('Kick webhook receiver closed');
      const name = normalizeTarget(target);
      if (!targets.has(name)) throw new Error('Unknown Kick webhook relay target');
      const group = listeners.get(name) ?? new Set<Listener>();
      // Each connection owns a distinct callback identity.
      const listener = { ...callbacks };
      group.add(listener);
      listeners.set(name, group);
      const close = () => {
        if (!group.delete(listener)) return;
        if (group.size === 0 && listeners.get(name) === group) listeners.delete(name);
        try { listener.onStateChange('disconnected'); } catch (error) { report(listener, error); }
      };
      try { listener.onStateChange('connected'); } catch (error) { close(); throw error; }
      return { close };
    },
    close() {
      if (closed) return;
      closed = true;
      const all = [...listeners.values()].flatMap(group => [...group]);
      for (const group of listeners.values()) group.clear();
      listeners.clear();
      for (const listener of all) {
        try { listener.onStateChange('disconnected'); } catch (error) { report(listener, error); }
      }
    },
  };
}
