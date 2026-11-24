import {
  isInternalHostname,
  isSpecialPurposeAddress,
  ValidationError,
} from '@contentworker/domain';

/**
 * Pure, DNS-free SSRF guard for user-supplied outbound URLs (webhook targets, function
 * endpoints, asset and site-migration sources, plugin packages, oEmbed). It refuses non-http(s)
 * schemes, any IP literal in an IANA special-purpose range (loopback, private, link-local,
 * CGNAT, documentation, benchmarking, multicast, reserved, and IPv6 forms that wrap one of those
 * IPv4 addresses), and `localhost` and local-only names, with or without a trailing dot. The
 * lists live in `@contentworker/domain` (`isSpecialPurposeAddress`, `isInternalHostname`), shared
 * with the admin's egress policy.
 *
 * This is the first line of defence and is portable everywhere (no I/O). It cannot catch a
 * public hostname that *resolves* to an internal IP (DNS rebinding): the Workers set
 * `global_fetch_strictly_public`, so `fetch` never reaches a private address, and the sending
 * adapters (`RemoteFetcher`, the webhook sender, the function invoker) use `redirect: 'manual'`,
 * so a 3xx can't move a screened request to a host nothing screened.
 */
export function assertSafeExternalUrl(rawUrl: string, field = 'url'): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError([{ field, message: 'must be a valid absolute URL' }]);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError([{ field, message: 'must use http or https' }]);
  }
  if (isInternalHostname(url.hostname) || isSpecialPurposeAddress(url.hostname)) {
    throw new ValidationError([
      { field, message: 'must not target a loopback, link-local, or private address' },
    ]);
  }
}
