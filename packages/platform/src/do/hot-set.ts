import { DurableObject } from 'cloudflare:workers';
import type { EdgeEnv } from '../env';
import {
  HOT_SET_MAX_URLS,
  HOT_SET_MIN_HITS,
  HOT_SET_TTL_MS,
  type HotRead,
  type HotUrl,
  nextRank,
  type ProfilePrincipal,
} from '../hot-urls';

export type { HotRead, HotUrl, ProfilePrincipal };

/**
 * The Delivery URLs readers actually ask for in one space:environment, hottest first, so the
 * delivery Worker can request them again right after a publish refreshes the cache. One object per
 * space:environment (`idFromName('<space>:<environment>')`), in SQLite storage. Fed by the
 * cached entrypoint's renders (a miss or revalidation; it never runs on a hit), which each isolate
 * batches and flushes at most once a minute. The URL cap holds on every write, so a reader minting
 * unique URLs can't grow the object past twice the cap.
 */
export class HotSetDO extends DurableObject<EdgeEnv> {
  private ready = false;
  /** Rows in `urls` as of the last count (undefined until counted). */
  private rows: number | undefined;
  private alarmSet = false;

  private sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.ready) {
      sql.exec(`create table if not exists urls (
        url text primary key,
        profile text not null,
        rank real not null,
        seen integer not null,
        hits integer not null
      )`);
      sql.exec('create index if not exists urls_rank on urls (rank desc)');
      sql.exec(`create table if not exists profiles (
        profile text primary key,
        principal text not null
      )`);
      this.ready = true;
    }
    return sql;
  }

  /** Counts one read of `url` by a reader with `profile`. */
  async record(url: string, profile: string, principal: ProfilePrincipal): Promise<void> {
    await this.recordMany([{ url, profile, principal, weight: 1 }]);
  }

  /** Counts a batch of reads (an isolate's flush). */
  async recordMany(reads: readonly HotRead[]): Promise<void> {
    const sql = this.sql();
    const now = Date.now();
    this.rows ??= sql.exec<{ n: number }>('select count(*) as n from urls').one().n;
    for (const r of reads) {
      const weight = Math.max(1, Math.floor(r.weight));
      const row = sql
        .exec<{ rank: number }>('select rank from urls where url = ?', r.url)
        .toArray()[0];
      if (!row) this.rows++;
      sql.exec(
        `insert into urls (url, profile, rank, seen, hits) values (?, ?, ?, ?, ?)
         on conflict (url) do update set profile = excluded.profile, rank = excluded.rank,
           seen = excluded.seen, hits = urls.hits + excluded.hits`,
        r.url,
        r.profile,
        nextRank(row?.rank, now, weight),
        now,
        weight,
      );
      // The profile is a hash of this very shape: an existing row is already right.
      sql.exec(
        'insert into profiles (profile, principal) values (?, ?) on conflict (profile) do nothing',
        r.profile,
        JSON.stringify(r.principal),
      );
    }
    if (this.rows > 2 * HOT_SET_MAX_URLS) await this.prune();
    // Housekeeping once a day, whenever the object is in use.
    if (!this.alarmSet) {
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(now + 24 * 60 * 60 * 1000);
      }
      this.alarmSet = true;
    }
  }

  /**
   * The hottest `limit` URLs, each with the reader to request it as. Only URLs read more than once:
   * a URL rendered once (a one-off query, or someone minting unique URLs to crowd the set) is not
   * worth a render after every publish.
   */
  async top(limit: number): Promise<HotUrl[]> {
    const rows = this.sql()
      .exec<{ url: string; principal: string }>(
        `select u.url, p.principal from urls u join profiles p on p.profile = u.profile
         where u.seen >= ? and u.hits >= ? order by u.rank desc limit ?`,
        Date.now() - HOT_SET_TTL_MS,
        HOT_SET_MIN_HITS,
        Math.max(0, Math.min(limit, HOT_SET_MAX_URLS)),
      )
      .toArray();
    return rows.map((r) => ({
      url: r.url,
      principal: JSON.parse(r.principal) as ProfilePrincipal,
    }));
  }

  /** How many URLs it holds. */
  async size(): Promise<number> {
    return this.sql().exec<{ n: number }>('select count(*) as n from urls').one().n;
  }

  /** Forgets URLs past their TTL or beyond the cap, and profiles no URL uses. */
  async prune(): Promise<void> {
    const sql = this.sql();
    sql.exec('delete from urls where seen < ?', Date.now() - HOT_SET_TTL_MS);
    sql.exec(
      `delete from urls where url not in (select url from urls order by rank desc limit ?)`,
      HOT_SET_MAX_URLS,
    );
    sql.exec('delete from profiles where profile not in (select distinct profile from urls)');
    this.rows = sql.exec<{ n: number }>('select count(*) as n from urls').one().n;
  }

  override async alarm(): Promise<void> {
    this.alarmSet = false;
    await this.prune();
    const left = this.sql().exec<{ n: number }>('select count(*) as n from urls').one().n;
    // An object nobody reads any more empties itself and stops waking up.
    if (left === 0) {
      await this.ctx.storage.deleteAll();
      this.ready = false;
      this.rows = undefined;
    } else {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
      this.alarmSet = true;
    }
  }
}
