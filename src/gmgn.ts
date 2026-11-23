import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getCache, setCache } from "./db.js";
import { Pacer } from "./ratelimit.js";
import {
  klineCacheTtlMs,
  parseGmgnKline,
  resolutionToMs,
  selectClosedCandles,
  type Candle,
} from "./supertrend.js";

export interface RankItem {
  address: string;
  symbol?: string;
  name?: string;
  market_cap?: number;
  history_highest_market_cap?: number;
  creation_timestamp?: number;
  open_timestamp?: number;
  volume?: number;
  liquidity?: number;
  [key: string]: unknown;
}

export interface TokenInfo {
  address: string;
  symbol?: string;
  name?: string;
  total_fee?: string | number;
  trade_fee?: string | number;
  ath_price?: number;
  creation_timestamp?: number;
  open_timestamp?: number;
  circulating_supply?: string;
  price?: {
    price?: string;
    volume_5m?: string;
    volume_1h?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TokenSecurity {
  blacklist?: number | null;
  is_blacklist?: number | null;
  honeypot?: number | null;
  is_honeypot?: number | null;
  can_sell?: number | null;
  can_not_sell?: number | null;
  renounced_mint?: boolean | null;
  renounced_freeze_account?: boolean | null;
  flags?: string[];
  [key: string]: unknown;
}

export const pacer = new Pacer({
  minGapMs: config.gmgn.minGapMs,
  maxGapMs: config.gmgn.maxGapMs,
});

const infoKey = (mint: string) => `info:${mint}`;
const securityKey = (mint: string) => `sec:${mint}`;

function unwrap(json: unknown): unknown {
  let current: unknown = json;

  if (current && typeof current === "object" && "data" in current) {
    current = (current as { data: unknown }).data;
  }

  // GMGN sometimes wraps the payload twice: {code, data: {code, data: {...}}}
  if (
    current &&
    typeof current === "object" &&
    "data" in current &&
    !("address" in current) &&
    !("rank" in current)
  ) {
    current = (current as { data: unknown }).data;
  }

  return current;
}

function parseRetryAfterMs(headers: Headers, json: Record<string, unknown>): number {
  const headerRetry = Number(headers.get("retry-after") ?? 0);
  if (Number.isFinite(headerRetry) && headerRetry > 0) return headerRetry * 1000;

  const resetAt = Number(json.reset_at ?? headers.get("x-ratelimit-reset") ?? 0);
  if (Number.isFinite(resetAt) && resetAt > 0) {
    return Math.max(1_000, resetAt * 1000 - Date.now() + 500);
  }

  return 30_000;
}

async function request(
  path: string,
  params: Record<string, string | number>,
): Promise<unknown> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await pacer.schedule(async () => {
        const url = new URL(path, config.gmgn.baseUrl);
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, String(value));
        }
        url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
        url.searchParams.set("client_id", randomUUID());

        const response = await fetch(url, {
          headers: {
            "X-APIKEY": config.gmgn.apiKey,
            accept: "application/json",
            "user-agent": "gmgn-runner-alert/1.0",
          },
          signal: AbortSignal.timeout(20_000),
        });

        const raw = await response.text();
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          throw new Error(
            `GMGN ${path} returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`,
          );
        }

        const code = Number(json.code ?? 0);

        if (response.status === 429 || code === 429) {
          const error = new Error(`GMGN rate limited on ${path}`);
          (error as Error & { retryAfterMs?: number }).retryAfterMs =
            parseRetryAfterMs(response.headers, json);
          throw error;
        }

        if (!response.ok) {
          throw new Error(
            `GMGN ${path} HTTP ${response.status}: ${raw.slice(0, 200)}`,
          );
        }

        if (code !== 0) {
          const message = String(json.message ?? json.error ?? "");
          throw new Error(`GMGN ${path} code=${code}: ${message}`);
        }

        pacer.reward();
        return unwrap(json);
      });
    } catch (error) {
      const retryAfterMs = (error as Error & { retryAfterMs?: number }).retryAfterMs;
      if (retryAfterMs === undefined) throw error;

      if (attempt === maxAttempts) {
        throw new Error(`GMGN ${path} still rate limited after ${maxAttempts} attempts`);
      }

      pacer.penalize(retryAfterMs, path);
    }
  }

  throw new Error(`GMGN ${path} exhausted retries`);
}

export async function getTrending(): Promise<RankItem[]> {
  const data = await request("/v1/market/rank", {
    chain: "sol",
    interval: config.scan.interval,
    limit: config.scan.limit,
    order_by: config.scan.orderBy,
    direction: "desc",
  });

  const rank = (data as { rank?: unknown })?.rank;
  return Array.isArray(rank) ? (rank as RankItem[]) : [];
}

export async function getTokenInfo(
  mint: string,
  ttlMs = config.scan.infoCacheMs,
): Promise<TokenInfo> {
  if (ttlMs > 0) {
    const cached = getCache<TokenInfo>(infoKey(mint), ttlMs);
    if (cached) return cached;
  }

  const value = (await request("/v1/token/info", {
    chain: "sol",
    address: mint,
  })) as TokenInfo;

  setCache(infoKey(mint), value);
  return value;
}

/** Cached-only read: lets the cycle skip tokens already known to be unsafe. */
export function peekTokenSecurity(
  mint: string,
  ttlMs = config.scan.securityCacheMs,
): TokenSecurity | undefined {
  return getCache<TokenSecurity>(securityKey(mint), ttlMs);
}

export async function getTokenSecurity(
  mint: string,
  ttlMs = config.scan.securityCacheMs,
): Promise<TokenSecurity> {
  if (ttlMs > 0) {
    const cached = getCache<TokenSecurity>(securityKey(mint), ttlMs);
    if (cached) return cached;
  }

  const value = (await request("/v1/token/security", {
    chain: "sol",
    address: mint,
  })) as TokenSecurity;

  setCache(securityKey(mint), value);
  return value;
}

interface KlineCacheEntry {
  /** Absolute unix ms. A closed-candle snapshot is stale once the next bar closes. */
  expiresAt: number;
  candles: Candle[];
}

const klineKey = (mint: string, resolution: string, limit: number) =>
  `kline:${resolution}:${limit}:${mint}`;

/**
 * OHLCV from GMGN. Used when SUPERTREND_SOURCE=gmgn, or as the optional
 * fallback when Meteora has no DLMM pool and SUPERTREND_FALLBACK_GMGN=true.
 *
 * Route: `GET /v1/market/token_kline`, the same as gmgn-cli
 * `OpenApiClient.getTokenKline` (chain, address, resolution, and `from`/`to`
 * in milliseconds). The call goes through `request`, so it shares the GMGN
 * pacer. This route weighs 2 on the IP bucket.
 *
 * The returned candles are closed only. The forming bar is dropped before the
 * snapshot is cached, and the cache expires at the next bar close (or sooner,
 * when SUPERTREND_CACHE_MS is shorter).
 */
export async function getTokenKline(mint: string): Promise<Candle[]> {
  const resolution = config.supertrend.timeframe;
  const limit = config.supertrend.candles;
  const resolutionMs = resolutionToMs(resolution);
  const nowMs = Date.now();
  const key = klineKey(mint, resolution, limit);
  const maxAgeMs = Math.max(config.supertrend.cacheMs, resolutionMs);

  if (config.supertrend.cacheMs > 0) {
    const cached = getCache<KlineCacheEntry>(key, maxAgeMs);
    if (cached && cached.expiresAt > nowMs && Array.isArray(cached.candles)) {
      return cached.candles;
    }
  }

  const data = await request("/v1/market/token_kline", {
    chain: "sol",
    address: mint,
    resolution,
    from: nowMs - (limit + 2) * resolutionMs,
    to: nowMs,
  });

  const closed = selectClosedCandles(parseGmgnKline(data), resolutionMs, nowMs, limit);
  if (config.supertrend.cacheMs > 0 && closed.length > 0) {
    const entry: KlineCacheEntry = {
      expiresAt: nowMs + klineCacheTtlMs(nowMs, resolutionMs, config.supertrend.cacheMs),
      candles: closed,
    };
    setCache(key, entry);
  }
  return closed;
}

export interface SecurityVerdict {
  ok: boolean;
  blacklist: number;
  honeypot: number;
  mintRenounced: boolean;
  freezeRenounced: boolean;
}

export function evaluateSecurity(security: TokenSecurity): SecurityVerdict {
  const blacklist = Number(security.blacklist ?? 0);
  const honeypot = Number(security.honeypot ?? 0);
  const mintRenounced = security.renounced_mint === true;
  const freezeRenounced = security.renounced_freeze_account === true;

  return {
    ok: blacklist === 0 && honeypot === 0 && mintRenounced && freezeRenounced,
    blacklist,
    honeypot,
    mintRenounced,
    freezeRenounced,
  };
}

export function notePacerStats(): { gapMs: number } {
  log.debug("pacer stats", { gapMs: pacer.currentGapMs });
  return { gapMs: pacer.currentGapMs };
}
