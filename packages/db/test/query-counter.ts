/**
 * Counts what the D1 store sends to D1, for the query-count snapshots (query-counts.test.ts).
 *
 * The wrapper sits between `createD1Store` and the binding, so it sees exactly what a Worker's
 * D1 binding sees. A statement run on its own (`all`, `run`, `first`, `raw`) is one statement
 * and one round trip; a `batch()` is one round trip carrying all of its statements; `exec()` is
 * one round trip of one statement. A read-replica session (`withSession`) counts the same way.
 */

export interface QueryCount {
  /** SQL statements D1 executed. */
  readonly statements: number;
  /** Calls to D1, one per lone statement or per batch: the latency a request pays. */
  readonly roundTrips: number;
}

export interface QueryLog extends QueryCount {
  /** Every statement's SQL, in order (batched ones marked), for the drift report. */
  readonly sql: readonly string[];
}

export interface CountingD1 {
  /** The binding to hand to `createD1Store`. */
  readonly d1: D1Database;
  /** Counts the D1 traffic of `fn` alone. Measurements must not overlap. */
  measure(fn: () => Promise<unknown>): Promise<QueryLog>;
}

const EXECUTE = new Set<PropertyKey>(['all', 'run', 'first', 'raw']);

export function countingD1(target: D1Database): CountingD1 {
  let statements = 0;
  let roundTrips = 0;
  let sql: string[] = [];
  // `batch()` must receive the binding's own statements, not the proxies; the text is kept for
  // the log.
  const original = new WeakMap<object, { stmt: D1PreparedStatement; text: string }>();

  const wrapStatement = (stmt: D1PreparedStatement, text: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(t, key) {
        if (key === 'bind') {
          return (...values: unknown[]) => wrapStatement(t.bind(...values), text);
        }
        const value = Reflect.get(t, key, t);
        if (typeof value !== 'function') return value;
        if (!EXECUTE.has(key)) return value.bind(t);
        return (...args: unknown[]) => {
          statements += 1;
          roundTrips += 1;
          sql.push(text);
          return value.apply(t, args);
        };
      },
    });
    original.set(proxy, { stmt, text });
    return proxy;
  };

  const wrapDatabase = <T extends D1Database | D1DatabaseSession>(db: T): T =>
    new Proxy(db, {
      get(t, key) {
        const value = Reflect.get(t, key, t);
        if (typeof value !== 'function') return value;
        switch (key) {
          case 'prepare':
            return (query: string) => wrapStatement(t.prepare(query), query);
          case 'batch':
            return (batch: D1PreparedStatement[]) => {
              roundTrips += 1;
              statements += batch.length;
              const unwrapped = batch.map((s) => {
                const o = original.get(s);
                sql.push(`[batch] ${o?.text ?? '?'}`);
                return o?.stmt ?? s;
              });
              return t.batch(unwrapped);
            };
          case 'exec':
            return (query: string) => {
              roundTrips += 1;
              statements += 1;
              sql.push(query);
              return (t as D1Database).exec(query);
            };
          case 'withSession':
            return (constraintOrBookmark?: string) =>
              wrapDatabase((t as D1Database).withSession(constraintOrBookmark));
          default:
            return value.bind(t);
        }
      },
    });

  return {
    d1: wrapDatabase(target),
    async measure(fn) {
      statements = 0;
      roundTrips = 0;
      sql = [];
      await fn();
      return { statements, roundTrips, sql };
    },
  };
}
