/**
 * Wildcard patterns without regular expressions: robots.txt rules and run path globs come from
 * people and sites, and a regex built from one can backtrack without bound. A pattern is compiled
 * once into tokens and matched by walking the text once, carrying the set of pattern positions
 * still alive (at most pattern-length of them): time is text length × token count, whatever the
 * pattern. Internal to the migration module.
 */

type Token =
  | { readonly kind: 'literal'; readonly text: string }
  /** Any run of characters; with `segment`, any run without a `/`. */
  | { readonly kind: 'star'; readonly segment: boolean };

export interface Wildcard {
  readonly tokens: readonly Token[];
  /** The text must end where the pattern does; else the pattern need only match a prefix. */
  readonly anchored: boolean;
}

/**
 * Compiles `pattern`. `glob`: `*` stays within a segment, `**` crosses, and the whole path must
 * match. `robots`: `*` is any run, a trailing `$` anchors the end, and a prefix match suffices.
 */
export function compileWildcard(pattern: string, dialect: 'glob' | 'robots'): Wildcard {
  let body = pattern;
  let anchored = dialect === 'glob';
  if (dialect === 'robots' && body.endsWith('$')) {
    anchored = true;
    body = body.slice(0, -1);
  }
  const tokens: Token[] = [];
  let literal = '';
  const flush = () => {
    if (literal) tokens.push({ kind: 'literal', text: literal });
    literal = '';
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c !== '*') {
      literal += c;
      continue;
    }
    flush();
    const double = body[i + 1] === '*';
    if (double) i += 1;
    const segment = dialect === 'glob' && !double;
    const last = tokens[tokens.length - 1];
    // Consecutive stars are one: the wider of them.
    if (last?.kind === 'star') {
      tokens[tokens.length - 1] = { kind: 'star', segment: last.segment && segment };
    } else tokens.push({ kind: 'star', segment });
  }
  flush();
  return { tokens, anchored };
}

/** Whether `text` matches the compiled pattern. */
export function matchWildcard(w: Wildcard, text: string): boolean {
  // Expand literals to one state per character, so a state is a position in a flat program.
  const program: ({ kind: 'char'; c: string } | { kind: 'star'; segment: boolean })[] = [];
  for (const t of w.tokens) {
    if (t.kind === 'star') program.push(t);
    else for (const c of t.text) program.push({ kind: 'char', c });
  }
  const end = program.length;
  // A star may match nothing, so a state at a star also stands at the state after it.
  const close = (states: Set<number>): Set<number> => {
    for (const s of [...states]) {
      let at = s;
      while (at < end && program[at]?.kind === 'star') {
        at += 1;
        states.add(at);
      }
    }
    return states;
  };
  let states = close(new Set([0]));
  for (const c of text) {
    if (!w.anchored && states.has(end)) return true;
    const next = new Set<number>();
    for (const s of states) {
      const op = program[s];
      if (!op) continue;
      if (op.kind === 'star') {
        if (!op.segment || c !== '/') next.add(s);
      } else if (op.c === c) next.add(s + 1);
    }
    if (next.size === 0) return false;
    states = close(next);
  }
  return states.has(end);
}
