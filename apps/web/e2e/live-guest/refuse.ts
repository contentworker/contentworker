/**
 * A page that connects and reports the entry, then refuses its state as invalid: what a frontend
 * does when it can't read the entry as the admin sends it. The admin says the entry can't be
 * previewed and never sends that state again. Speaks the wire protocol by hand, as the SDK would.
 */
import { acceptMessage, newChannel, parseAdminMessage } from '@contentworker/sdk-core/live-preview';

declare const __ADMIN_ORIGIN__: string;

const channel = newChannel();
const entryId = new URL(location.href).searchParams.get('entry') ?? '';
const post = (message: Record<string, unknown>) =>
  window.parent.postMessage({ v: 1, channel, ...message }, __ADMIN_ORIGIN__);

window.addEventListener('message', (event) => {
  const data = acceptMessage(event, { origin: __ADMIN_ORIGIN__, source: window.parent, channel });
  if (!data) return;
  const parsed = parseAdminMessage(data);
  if (!parsed.ok) return;
  const m = parsed.message;
  if (m.kind === 'connect.accept') {
    post({
      kind: 'page',
      url: location.href,
      entries: [{ entryId, contentType: 'refusingPage', locale: 'en-US' }],
    });
  } else if (m.kind === 'entry.state') {
    post({ kind: 'failed', rev: m.rev, reason: 'invalid', entryId: m.entryId });
  }
});

post({
  kind: 'connect.offer',
  versions: [1],
  capabilities: ['select', 'patch.fields'],
  sdk: { name: '@contentworker/sdk', version: '0.2.0' },
});
