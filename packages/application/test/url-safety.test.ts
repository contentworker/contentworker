import { ValidationError } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { assertSafeExternalUrl } from '../src/url-safety';

describe('assertSafeExternalUrl (SSRF guard)', () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://localhost/hook',
    'https://localhost:8443/hook',
    'http://127.0.0.1/x',
    'http://127.9.9.9/x',
    'http://0.0.0.0/x',
    'http://10.0.0.5:6379/x',
    'http://192.168.1.10/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://100.64.0.1/x', // CGNAT
    'http://internal.local/x',
    'http://svc.internal/x',
    'http://[::1]/x',
    'http://[fd00::1]/x', // unique-local
    'http://[fe80::1]/x', // link-local
    'http://[::ffff:127.0.0.1]/x', // ipv4-mapped loopback
    'ftp://example.com/x', // non-http scheme
    'file:///etc/passwd',
    'not-a-url',
  ];

  // A trailing root dot names the same host, on any blocked name or literal.
  const trailingDot = [
    'http://localhost./x',
    'http://localhost../x',
    'http://LOCALHOST./x',
    'http://127.0.0.1./x',
    'http://metadata.google.internal./x',
    'http://metadata.google.internal/x',
    'http://printer.local./x',
    'http://app.localhost./x',
    'http://localhost%2e/x', // percent-encoded dot
    'http://localhost\u3002/x', // ideographic full stop, mapped to '.'
  ];

  // Every IPv4-carrying IPv6 spelling the WHATWG parser accepts, each wrapping a blocked v4.
  const embeddedV4 = [
    'http://[::ffff:127.0.0.1]/x', // mapped, dotted (normalized to ::ffff:7f00:1)
    'http://[::ffff:7f00:1]/x', // mapped, hex
    'http://[0:0:0:0:0:ffff:127.0.0.1]/x', // mapped, uncompressed
    'http://[::ffff:a9fe:a9fe]/x', // mapped metadata address
    'http://[::ffff:10.0.0.1]/x',
    'http://[::ffff:0:7f00:1]/x', // IPv4-translated (SIIT)
    'http://[::127.0.0.1]/x', // compatible, dotted
    'http://[::7f00:1]/x', // compatible, hex
    'http://[::8.8.8.8]/x', // compatible is deprecated: refused whatever it wraps
    'http://[::192.168.0.1]/x',
    'http://[64:ff9b::127.0.0.1]/x', // NAT64 well-known prefix
    'http://[64:ff9b::a00:1]/x',
    'http://[64:ff9b::a9fe:a9fe]/x',
    'http://[64:ff9b:1::1]/x', // NAT64 local-use /48: never public
    'http://[64:ff9b:1:ffff::8.8.8.8]/x',
    'http://[2002:7f00:1::]/x', // 6to4 wrapping 127.0.0.1
    'http://[2002:a00:1::1]/x', // 6to4 wrapping 10.0.0.1
    'http://[2002:c0a8:101::]/x', // 6to4 wrapping 192.168.1.1
    'http://[2002:a9fe:a9fe::]/x',
  ];

  // IANA special-purpose ranges, first and last address where it matters.
  const specialPurpose = [
    'http://0.0.0.0/x',
    'http://0.255.255.255/x', // 0.0.0.0/8
    'http://100.127.255.255/x', // 100.64.0.0/10
    'http://169.254.0.1/x',
    'http://192.0.0.8/x', // 192.0.0.0/24 IETF protocol assignments
    'http://192.0.2.1/x', // TEST-NET-1
    'http://192.88.99.1/x', // 6to4 relay anycast
    'http://198.18.0.1/x', // benchmarking 198.18.0.0/15
    'http://198.19.255.255/x',
    'http://198.51.100.7/x', // TEST-NET-2
    'http://203.0.113.7/x', // TEST-NET-3
    'http://224.0.0.1/x', // multicast
    'http://239.255.255.250/x',
    'http://240.0.0.1/x', // reserved 240.0.0.0/4
    'http://255.255.255.255/x', // limited broadcast
    'http://[::]/x', // unspecified
    'http://[0:0:0:0:0:0:0:1]/x', // loopback, uncompressed
    'http://[100::1]/x', // discard-only 100::/64
    'http://[fc00::1]/x', // unique-local fc00::/7
    'http://[fdff:ffff::1]/x',
    'http://[febf::1]/x', // end of fe80::/10
    'http://[fec0::1]/x', // deprecated site-local
    'http://[ff02::1]/x', // multicast
    'http://[2001:db8::1]/x', // documentation
    'http://[3fff::1]/x', // documentation 3fff::/20
    'http://[2001::1]/x', // Teredo 2001::/32
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x',
    'http://[2001:2::1]/x', // benchmarking 2001:2::/48
    'http://[5f00::1]/x', // SRv6 SIDs
    'http://[1::ffff:7f00:1]/x', // reserved ::/8, outside global unicast
    'http://[64:ff9b:0:1::7f00:1]/x', // the rest of 64:ff9b::/32
    'http://[4000::1]/x', // unassigned
    'http://[fe7f::1]/x', // unassigned, just below link-local
  ];

  // Decimal, octal, hex and shortened IPv4: the URL parser normalizes each to a dotted quad.
  const numericV4 = [
    ['http://2130706433/x', '127.0.0.1'],
    ['http://017700000001/x', '127.0.0.1'],
    ['http://0x7f000001/x', '127.0.0.1'],
    ['http://0x7f.1/x', '127.0.0.1'],
    ['http://0177.0.0.1/x', '127.0.0.1'],
    ['http://127.1/x', '127.0.0.1'],
    ['http://0/x', '0.0.0.0'],
    ['http://0xa9.0xfe.0xa9.0xfe/x', '169.254.169.254'],
    ['http://2852039166/x', '169.254.169.254'],
    ['http://012.0.0.1/x', '10.0.0.1'],
    ['http://3232235777/x', '192.168.1.1'],
  ] as const;

  for (const [url, normalized] of numericV4) {
    it(`normalizes ${url} to ${normalized} and rejects it`, () => {
      expect(new URL(url).hostname).toBe(normalized);
      expect(() => assertSafeExternalUrl(url)).toThrow(ValidationError);
    });
  }

  for (const url of [...blocked, ...trailingDot, ...embeddedV4, ...specialPurpose]) {
    it(`rejects ${url}`, () => {
      expect(() => assertSafeExternalUrl(url)).toThrow(ValidationError);
    });
  }

  const allowed = [
    'https://hooks.example.com/cw',
    'http://example.com/x',
    'https://a/', // public single-label placeholder
    'https://api.stripe.com/v1/x',
    'http://172.15.0.1/x', // just outside private range
    'http://172.32.0.1/x',
    'http://8.8.8.8/x',
    'http://example.com./x', // trailing dot on a public name
    'http://192.0.1.1/x', // between 192.0.0.0/24 and 192.0.2.0/24
    'http://198.17.255.255/x', // just below 198.18.0.0/15
    'http://198.20.0.1/x', // just above it
    'http://100.63.255.255/x', // just below CGNAT
    'http://100.128.0.1/x', // just above it
    'http://223.255.255.255/x', // just below multicast
    'http://[2606:4700:4700::1111]/x', // public IPv6
    'http://[::ffff:8.8.8.8]/x', // mapped public v4 is that v4
    'http://[64:ff9b::808:808]/x', // NAT64 of a public v4
    'http://[2002:808:808::1]/x', // 6to4 of a public v4
    'http://[2001:200::1]/x', // first RIR allocation past 2001::/23
    'http://[2001:db9::1]/x', // just past documentation
    'http://[3fff:1000::1]/x', // just past documentation 3fff::/20
    'http://localhost.example.com/x', // "localhost" as a label, not the name
    'http://internal.example.com/x',
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => assertSafeExternalUrl(url)).not.toThrow();
    });
  }

  it('reports the given field name', () => {
    try {
      assertSafeExternalUrl('http://127.0.0.1', 'entryUrl');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).issues[0]?.field).toBe('entryUrl');
    }
  });

  it('keeps the same issue for every refused host form', () => {
    for (const url of ['http://localhost./', 'http://[::ffff:7f00:1]/', 'http://198.18.0.1/']) {
      try {
        assertSafeExternalUrl(url, 'target');
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as ValidationError).issues).toEqual([
          {
            field: 'target',
            message: 'must not target a loopback, link-local, or private address',
          },
        ]);
      }
    }
  });
});
