/**
 * An SDK release the admin doesn't speak: it offers only protocol version 99, as a frontend on a
 * release the admin has no version in common with would. The admin answers `connect.reject` with
 * both lists and says why, rather than waiting for an offer it can accept.
 */
import { newChannel } from '@contentworker/sdk-core/live-preview';

declare const __ADMIN_ORIGIN__: string;

window.parent.postMessage(
  {
    v: 99,
    channel: newChannel(),
    kind: 'connect.offer',
    versions: [99],
    capabilities: ['select'],
    sdk: { name: '@contentworker/sdk', version: '9.0.0' },
  },
  __ADMIN_ORIGIN__,
);
