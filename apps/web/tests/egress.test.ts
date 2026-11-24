import { describe, expect, it } from 'vitest';
import { egressProblem, isInternalName } from '../app/lib/egress';

// The address and name lists are shared with the application's URL guard
// (`@contentworker/domain`); this proves the admin's policy reads them.
describe('egressProblem', () => {
  it('names special-purpose literals as private and other literals as IP addresses', () => {
    expect(egressProblem('https://198.18.0.1/')).toBe('a private address (198.18.0.1)');
    expect(egressProblem('https://[::ffff:7f00:1]/')).toBe('a private address ([::ffff:7f00:1])');
    expect(egressProblem('https://[2002:a00:1::]/')).toBe('a private address ([2002:a00:1::])');
    expect(egressProblem('https://8.8.8.8/')).toBe('an IP address (8.8.8.8)');
    // 192.0.1.0/24 is public; only 192.0.0.0/24 and 192.0.2.0/24 are special.
    expect(egressProblem('https://192.0.1.1/')).toBe('an IP address (192.0.1.1)');
  });

  it('refuses internal names and trailing dots, and allows a public name', () => {
    expect(egressProblem('https://router.lan/')).toBe('an internal name (router.lan)');
    expect(egressProblem('https://localhost./')).toBe('a host ending in a dot (localhost.)');
    expect(egressProblem('https://idp.example.com/')).toBeNull();
  });
});

describe('isInternalName', () => {
  it('counts single labels as internal, as the shared list does local-only suffixes', () => {
    expect(isInternalName('intranet')).toBe(true);
    expect(isInternalName('metadata.google.internal.')).toBe(true);
    expect(isInternalName('idp.example.com')).toBe(false);
  });
});
