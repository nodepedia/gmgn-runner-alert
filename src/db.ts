import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
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
