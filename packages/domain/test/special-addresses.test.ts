import { describe, expect, it } from 'vitest';
import { isInternalHostname, isSpecialPurposeAddress } from '../src/index';

// The URL-level cases (normalized hosts, trailing dots, numeric IPv4) are in
// packages/application/test/url-safety.test.ts; these feed the classifier raw strings, the
// spellings a caller might pass without going through `URL` first.
describe('isSpecialPurposeAddress', () => {
  const special = [
    '127.0.0.1',
    '127.0.0.1.',
    '[::1]',
    '::',
    '0:0:0:0:0:0:0:0',
    '::ffff:127.0.0.1', // dotted tail, not yet normalized
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:0:10.0.0.1', // IPv4-translated
    '::127.0.0.1',
    '64:ff9b::192.168.0.1',
    '64:ff9b:1:2::3',
    '2002:c0a8:0101::',
    'fe80::1%eth0', // zone id
    'FE80::1', // upper case
    'ff05::2',
    '2001:0db8::1',
    '::ffff:', // unreadable IPv6: refused
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    'gggg::1',
    '1::ffff:7f00:1', // outside global unicast 2000::/3
    '4000::1',
  ];
  for (const host of special) {
    it(`treats ${host} as special-purpose`, () => {
      expect(isSpecialPurposeAddress(host)).toBe(true);
    });
  }

  const ordinary = [
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '::ffff:1.1.1.1',
    '64:ff9b::1.1.1.1',
    '2002:0101:0101::',
    'example.com',
    'localhost', // a name, not an address: isInternalHostname's job
    '256.1.1.1', // not an IPv4 literal
    // Raw numeric IPv4 isn't read as an address: callers pass `URL.hostname`, which normalizes it.
    '2130706433',
    '127.1',
  ];
  for (const host of ordinary) {
    it(`does not treat ${host} as special-purpose`, () => {
      expect(isSpecialPurposeAddress(host)).toBe(false);
    });
  }
});

describe('isInternalHostname', () => {
  it('refuses local-only names with or without trailing dots', () => {
    for (const host of [
      '',
      '.',
      'localhost',
      'localhost.',
      'LOCALHOST..',
      'a.localhost',
      'localhost.localdomain',
      'printer.local.',
      'metadata.google.internal',
      'metadata.google.internal.',
      'router.lan',
      'nas.home.arpa',
      'wiki.intranet',
      '127.0.0.1.nip.io',
      '10-0-0-1.sslip.io',
      'app.lvh.me',
    ]) {
      expect(isInternalHostname(host), host).toBe(true);
    }
  });

  it('allows public names, including ones that merely contain a local word', () => {
    for (const host of ['example.com', 'example.com.', 'localhost.example.com', 'local.dev', 'a']) {
      expect(isInternalHostname(host), host).toBe(false);
    }
  });
});
