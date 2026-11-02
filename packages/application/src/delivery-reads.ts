import type { Scope } from '@contentworker/domain';
import type { DeliveryReadRequest, DeliveryReadResult } from '@contentworker/ports';
import type { AppContext } from './context';

/**
 * One Delivery request's reads. Each `read` is one store call (one D1 round trip, however many
 * statements), and the parts every step of a request asks for again (the space config, the
 * content types, the rendition presets) are read once and remembered for the rest of it: a
 * GraphQL request that loaded them to build its schema doesn't load them again per field.
 *
 * Make one per request and drop it with the request: nothing here expires, so it must never be
 * held across requests (a long-lived one would serve a stale config). Remembered parts are keyed
 * by scope, so one request reading two scopes never mixes their answers. Entries and assets are
 * never remembered: each read asks for its own.
 */
export interface DeliveryReads {
  read(scope: Scope, request: DeliveryReadRequest): Promise<DeliveryReadResult>;
}

/** The parts read once per request. */
const REMEMBERED = ['config', 'contentTypes', 'renditions'] as const;
type Remembered = (typeof REMEMBERED)[number];

const asksForAnything = (request: DeliveryReadRequest): boolean =>
  Object.values(request).some((v) => v !== undefined && v !== false);

export function deliveryReads(ctx: Pick<AppContext, 'store'>): DeliveryReads {
  // In flight or settled, so two fields resolving at once share one read.
  const remembered = new Map<string, Promise<unknown>>();
  const keyOf = (part: Remembered, scope: Scope) =>
    `${part}\u0000${scope.spaceId}\u0000${scope.environmentId}`;

  return {
    async read(scope, request) {
      const ask: { -readonly [K in keyof DeliveryReadRequest]: DeliveryReadRequest[K] } = {
        ...request,
      };
      const known = new Map<Remembered, Promise<unknown>>();
      for (const part of REMEMBERED) {
        const hit = request[part] ? remembered.get(keyOf(part, scope)) : undefined;
        if (hit) {
          known.set(part, hit);
          delete ask[part];
        }
      }
      const fresh = asksForAnything(ask)
        ? ctx.store.delivery.read(scope, ask)
        : Promise.resolve<DeliveryReadResult>({});
      for (const part of REMEMBERED) {
        if (!ask[part]) continue;
        const key = keyOf(part, scope);
        const value = fresh.then((r) => r[part]);
        remembered.set(key, value);
        // A failed read isn't an answer: the next step asks again.
        value.catch(() => {
          if (remembered.get(key) === value) remembered.delete(key);
        });
      }
      const result: { -readonly [K in keyof DeliveryReadResult]: unknown } = { ...(await fresh) };
      for (const [part, value] of known) result[part] = await value;
      return result as DeliveryReadResult;
    },
  };
}
