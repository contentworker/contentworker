/**
 * Which hosts an outbound fetch must never be aimed at: IP literals in the IANA special-purpose
 * ranges (and IPv6 forms that carry such an IPv4 address), and names that only resolve inside a
 * network. Pure and DNS-free, so every surface that screens a URL (the application's
 * `assertSafeExternalUrl`, the admin's egress policy) shares one list instead of each keeping a
 * copy that drifts.
 *
 * Pass `URL.hostname`, never a raw host: only the WHATWG parser turns decimal, octal, hex and
 * shortened IPv4 (`2130706433`, `0x7f.1`, `127.1`) into the dotted quads read here, and a raw
 * spelling of that kind is not recognized as an address. Brackets, a zone id, upper case and
 * dotted IPv6 tails are accepted either way.
 */

/** IPv4 ranges that are not a public unicast destination: [first address, prefix length]. */
const IPV4_SPECIAL: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. limited broadcast 255.255.255.255
];

const IPV4_RANGES = IPV4_SPECIAL.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { net: (v4ToInt(parseIPv4(base) ?? []) & mask) >>> 0, mask };
});

/**
 * Names that resolve only inside a network, and wildcard-DNS services whose labels name any
 * address (`127.0.0.1.nip.io`). Matched on the name and every subdomain of it.
 */
const INTERNAL_NAME =
  /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home\.arpa|nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)$/;

/**
 * Whether `host` is an IP literal in a special-purpose range, or an IPv6 address that wraps a
 * special-purpose IPv4 one (IPv4-mapped, IPv4-translated, NAT64, 6to4). A name, or a public
 * address, is not. An IPv6-looking host that doesn't parse counts as special: refuse what can't
 * be read.
 */
export function isSpecialPurposeAddress(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  const v4 = parseIPv4(h);
  if (v4) return isSpecialIPv4(v4);
  if (!h.includes(':')) return false;
  const v6 = parseIPv6(h.split('%')[0] ?? h);
  return v6 === null || isSpecialIPv6(v6);
}

/**
 * Whether `host` names something only reachable inside a network: empty, `localhost`, or a name
 * under a local-only suffix. A trailing root dot (`localhost.`) names the same host, so it is
 * ignored.
 */
export function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  return h === '' || INTERNAL_NAME.test(h);
}

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.some((p) => p > 255) ? null : parts;
}

function v4ToInt(parts: readonly number[]): number {
  return parts.reduce((acc, p) => ((acc << 8) | p) >>> 0, 0);
}

function isSpecialIPv4(parts: readonly number[]): boolean {
  const ip = v4ToInt(parts);
  return IPV4_RANGES.some(({ net, mask }) => (ip & mask) >>> 0 === net);
}

/** Eight 16-bit groups, or null when `h` isn't an IPv6 address. */
function parseIPv6(h: string): number[] | null {
  let s = h;
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) is two groups written another way.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail?.[1] && tail[2]) {
    const v4 = parseIPv4(tail[2]);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    s = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  const all = [...head, ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - all.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  return words.map((g) => Number.parseInt(g, 16));
}

const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function isSpecialIPv6(w: readonly number[]): boolean {
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = w;
  const zeroTo = (n: number) => w.slice(0, n).every((x) => x === 0);
  // ::/96: unspecified (::), loopback (::1) and the deprecated IPv4-compatible form (::a.b.c.d),
  // which nothing public is reached by.
  if (zeroTo(6)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) reaches the IPv4 address itself; so does IPv4-translated
  // (::ffff:0:a.b.c.d). Judge the address they carry.
  if (zeroTo(5) && w5 === 0xffff) return isSpecialIPv4(embeddedV4(w6, w7));
  if (zeroTo(4) && w4 === 0xffff && w5 === 0) return isSpecialIPv4(embeddedV4(w6, w7));
  if (w0 === 0x64 && w1 === 0xff9b) {
    // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address in its last 32 bits; the
    // local-use 64:ff9b:1::/48 is never a public route at all.
    if (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return isSpecialIPv4(embeddedV4(w6, w7));
    if (w2 === 1) return true;
  }
  if (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) return true; // 100::/64 discard-only
  // 2001::/23 IETF protocol assignments: Teredo (2001::/32, which wraps an IPv4 address),
  // benchmarking (2001:2::/48) and ORCHID among them. 2001:db8::/32 is documentation.
  if (w0 === 0x2001 && (w1 < 0x200 || w1 === 0xdb8)) return true;
  if (w0 === 0x2002) return isSpecialIPv4(embeddedV4(w1, w2)); // 6to4 2002:a.b.c.d::/48
  if (w0 === 0x3fff && w1 < 0x1000) return true; // 3fff::/20 documentation
  if (w0 === 0x5f00) return true; // 5f00::/16 SRv6 SIDs
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((w0 & 0xff80) === 0xfe80) return true; // fe80::/10 link-local and fec0::/10 site-local
  if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Everything public is in global unicast 2000::/3; the rest of the space (the reserved ::/8
  // around the forms above, the unassigned 4000::/2, the rest of 64:ff9b::/32) has no route.
  return (w0 & 0xe000) !== 0x2000;
}
