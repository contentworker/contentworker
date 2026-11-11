import { describe, expect, it } from 'vitest';
import { isEmail } from '../src/index';

/** The pattern `isEmail` replaced: quadratic, but the answers it must keep. */
const BEFORE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TABLE: readonly [string, boolean][] = [
  ['ada@example.com', true],
  ['ada.lovelace+cw@mail.example.co.uk', true],
  ['a@b.c', true],
  ['a@.b.c', true], // a dot may lead the domain, as before (the `email` preset refuses it)
  ['a@b..c', true],
  ['a@b.c.', true],
  ['ünïcödé@exämple.org', true],
  ['ada@example', false],
  ['ada@.com', false],
  ['ada@example.', false],
  ['ada@', false],
  ['@example.com', false],
  ['ada', false],
  ['', false],
  ['ada@@example.com', false],
  ['ada@exa@mple.com', false],
  ['ada lovelace@example.com', false],
  ['ada@example .com', false],
  [' ada@example.com', false],
  ['ada@example.com\n', false],
  ['ada@example.com ', false],
  ['ada\t@example.com', false],
];

describe('isEmail', () => {
  it('answers a table of addresses as the pattern it replaced did', () => {
    for (const [email, expected] of TABLE) {
      expect([email, isEmail(email)]).toEqual([email, expected]);
      expect([email, BEFORE.test(email)]).toEqual([email, expected]);
    }
  });

  it('agrees with the old pattern on every string up to six characters over its alphabet', () => {
    const alphabet = ['a', '@', '.', ' ', '\n', ' '];
    let strings = [''];
    for (let length = 0; length <= 6; length++) {
      for (const s of strings) expect([s, isEmail(s)]).toEqual([s, BEFORE.test(s)]);
      strings = strings.flatMap((s) => alphabet.map((c) => s + c));
    }
  });

  it('finishes quickly on long adversarial input', () => {
    // A long run of dots after `@` that fails at the end: the old pattern tried every split of the
    // run between its domain and the dot (about 800 ms at 40,000 characters, 4x per doubling).
    const inputs = [
      `a@${'.'.repeat(100_000)} `,
      `a@${'a.'.repeat(50_000)}@`,
      `${'a'.repeat(100_000)}@`,
      `a@${'a'.repeat(100_000)}`,
    ];
    const started = performance.now();
    for (const input of inputs) expect(isEmail(input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
