import { DurableObject } from 'cloudflare:workers';
import type { EdgeEnv } from '../env';
import {
  HOT_SET_MAX_URLS,
  HOT_SET_TTL_MS,
  type HotUrl,
  nextRank,
  type ProfilePrincipal,
} from '../hot-urls';

export type { HotUrl, ProfilePrincipal };

/**
 * The Delivery URLs readers actually ask for in one space:environment, hottest first, so the
 * delivery Worker can request them again right after a publish refreshes the cache. One object per
 * space:environment (`idFromName('<space>:<environment>')`), in SQLite storage. Written only on a
 * cache miss or revalidation (the cached entrypoint never runs on a hit), throttled per isolate.
 */
export class HotSetDO extends DurableObject<EdgeEnv> {
  private ready = false;

  private sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.ready) {
      sql.exec(`create table if not exists urls (
        url text primary key,
        profile text not null,
        rank real not null,
        seen integer not null
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
    const sql = this.sql();
    const now = Date.now();
    const row = sql.exec<{ rank: number }>('select rank from urls where url = ?', url).toArray()[0];
    const rank = nextRank(row?.rank, now);
    sql.exec(
      `insert into urls (url, profile, rank, seen) values (?, ?, ?, ?)
       on conflict (url) do update set profile = excluded.profile, rank = excluded.rank,
         seen = excluded.seen`,
      url,
      profile,
      rank,
      now,
    );
    sql.exec(
      `insert into profiles (profile, principal) values (?, ?)
       on conflict (profile) do update set principal = excluded.principal`,
      profile,
      JSON.stringify(principal),
    );
    // Housekeeping once a day, whenever the object is in use.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + 24 * 60 * 60 * 1000);
    }
  }

  /** The hottest `limit` URLs, each with the reader to request it as. */
  async top(limit: number): Promise<HotUrl[]> {
    const rows = this.sql()
      .exec<{ url: string; principal: string }>(
        `select u.url, p.principal from urls u join profiles p on p.profile = u.profile
         where u.seen >= ? order by u.rank desc limit ?`,
        Date.now() - HOT_SET_TTL_MS,
        Math.max(0, Math.min(limit, HOT_SET_MAX_URLS)),
      )
      .toArray();
    return rows.map((r) => ({
      url: r.url,
      principal: JSON.parse(r.principal) as ProfilePrincipal,
    }));
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
  }

  override async alarm(): Promise<void> {
    await this.prune();
    const left = this.sql().exec<{ n: number }>('select count(*) as n from urls').one().n;
    // An object nobody reads any more empties itself and stops waking up.
    if (left === 0) {
      await this.ctx.storage.deleteAll();
      this.ready = false;
    } else await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }
}
