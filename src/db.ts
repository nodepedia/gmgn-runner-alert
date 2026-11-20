import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS token_state (
    mint TEXT PRIMARY KEY,
    symbol TEXT,
    first_seen INTEGER NOT NULL,
    last_alert INTEGER NOT NULL DEFAULT 0,
    alert_count INTEGER NOT NULL DEFAULT 0,
    last_mc REAL,
    last_ath_mc REAL,
    last_tvl REAL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS api_cache (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

export interface TokenState {
  mint: string;
  symbol: string | null;
  first_seen: number;
  last_alert: number;
  alert_count: number;
  last_mc: number | null;
  last_ath_mc: number | null;
  last_tvl: number | null;
}

const selectStmt = db.prepare("SELECT * FROM token_state WHERE mint = ?");

const upsertStmt = db.prepare(`
  INSERT INTO token_state (mint, symbol, first_seen, last_alert, alert_count, last_mc, last_ath_mc, last_tvl)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(mint) DO UPDATE SET
    symbol = excluded.symbol,
    last_alert = excluded.last_alert,
    alert_count = token_state.alert_count + 1,
    last_mc = excluded.last_mc,
    last_ath_mc = excluded.last_ath_mc,
    last_tvl = excluded.last_tvl
`);

const warmupStmt = db.prepare(`
  INSERT INTO token_state (mint, symbol, first_seen, last_alert, alert_count, last_mc, last_ath_mc, last_tvl)
  VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  ON CONFLICT(mint) DO UPDATE SET
    symbol = excluded.symbol,
    last_alert = excluded.last_alert,
    last_mc = excluded.last_mc,
    last_ath_mc = excluded.last_ath_mc,
    last_tvl = excluded.last_tvl
`);

export function getState(mint: string): TokenState | undefined {
  return selectStmt.get(mint) as TokenState | undefined;
}

export function canAlert(mint: string, nowMs = Date.now()): boolean {
  const state = getState(mint);
  if (!state) return true;
  return nowMs - state.last_alert * 1000 >= config.scan.cooldownMs;
}

export function recordAlert(input: {
  mint: string;
  symbol: string;
  marketCap: number;
  athMarketCap: number;
  tvlUsd: number;
}): void {
  const now = Math.floor(Date.now() / 1000);
  upsertStmt.run(
    input.mint,
    input.symbol,
    now,
    now,
    input.marketCap,
    input.athMarketCap,
    input.tvlUsd,
  );
}

/**
 * Seed state without notifying: the token gets a full cooldown so the first
 * live cycle does not dump every current trending token into Telegram.
 */
export function recordWarmup(input: {
  mint: string;
  symbol: string;
  marketCap: number;
  athMarketCap: number;
  tvlUsd: number;
}): void {
  const now = Math.floor(Date.now() / 1000);
  warmupStmt.run(
    input.mint,
    input.symbol,
    now,
    now,
    input.marketCap,
    input.athMarketCap,
    input.tvlUsd,
  );
}

const cacheSelectStmt = db.prepare(
  "SELECT payload, fetched_at FROM api_cache WHERE key = ?",
);
const cacheUpsertStmt = db.prepare(`
  INSERT INTO api_cache (key, payload, fetched_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
`);
const cachePruneStmt = db.prepare(
  "DELETE FROM api_cache WHERE fetched_at < ?",
);

export function getCache<T>(key: string, ttlMs: number): T | undefined {
  const row = cacheSelectStmt.get(key) as
    | { payload: string; fetched_at: number }
    | undefined;
  if (!row) return undefined;
  if (Date.now() - Number(row.fetched_at) > ttlMs) return undefined;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return undefined;
  }
}

export function setCache(key: string, value: unknown): void {
  cacheUpsertStmt.run(key, JSON.stringify(value), Date.now());
}

/** Drop cache rows older than the longest TTL we ever ask for. */
export function pruneCache(maxAgeMs = 24 * 60 * 60_000): void {
  cachePruneStmt.run(Date.now() - maxAgeMs);
}
