import { config } from "./config.js";
import { log } from "./logger.js";
import { getCache, setCache } from "./db.js";
import {
  fillCandleGaps,
  lastClosedOpenSec,
  mergeCandles,
  meteoraTimeframe,
  orientCandles,
  parseMeteoraOhlcv,
  planCandleRanges,
} from "./ohlcv.js";
import { klineCacheTtlMs, resolutionToMs, selectClosedCandles, type Candle } from "./supertrend.js";

/** Highest-TVL Meteora DLMM pool that contains the mint. Reused for OHLCV. */
export interface DlmmPoolRef {
  address: string;
  tvlUsd: number;
  /** `x` = OHLCV is already this token's price. `y` = invert OHLC. */
  side: "x" | "y";
}

export interface MeteoraTvl {
  tvlUsd: number;
  poolCount: number;
  /** false when every endpoint failed, so callers can skip TVL filters. */
  available: boolean;
  /** Best DLMM pool from the same fetch. Absent when DLMM had no match. */
  topDlmm?: DlmmPoolRef;
}

interface MeteoraPool {
  address?: string;
  tvl?: number | string;
  is_blacklisted?: boolean;
  token_x?: { address?: string };
  token_y?: { address?: string };
  [key: string]: unknown;
}

const DLMM_POOLS = "https://dlmm.datapi.meteora.ag/pools";
const DAMM_POOLS = "https://damm-v2.datapi.meteora.ag/pools";
const OHLCV_BASE = "https://dlmm.datapi.meteora.ag/pools";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** One OHLCV request in flight, a short gap so two chunks don't burst. */
const OHLCV_GAP_MS = 250;
const cacheKey = (mint: string) => `meteora:v2:${mint}`;

let ohlcvChain: Promise<unknown> = Promise.resolve();
let ohlcvLastStart = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceOhlcv<T>(task: () => Promise<T>): Promise<T> {
  const result = ohlcvChain.then(async () => {
    const wait = ohlcvLastStart + OHLCV_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    ohlcvLastStart = Date.now();
    return task();
  });
  ohlcvChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function fetchPools(endpoint: string, mint: string): Promise<MeteoraPool[]> {
  const matched: MeteoraPool[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${endpoint}?query=${encodeURIComponent(mint)}&page_size=${PAGE_SIZE}&page=${page}`;
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "gmgn-runner-alert/1.0" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`${endpoint} HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      data?: MeteoraPool[];
      pages?: number;
    };
    const rows = Array.isArray(json.data) ? json.data : [];

    for (const pool of rows) {
      const isThisToken =
        pool.token_x?.address === mint || pool.token_y?.address === mint;
      if (!isThisToken) continue;
      if (pool.is_blacklisted === true) continue;
      if (!Number.isFinite(Number(pool.tvl))) continue;
      matched.push(pool);
    }

    const pages = Number(json.pages ?? 1);
    if (page >= pages || rows.length === 0) break;
  }

  return matched;
}

function topDlmmPool(pools: MeteoraPool[], mint: string): DlmmPoolRef | undefined {
  let best: DlmmPoolRef | undefined;
  for (const pool of pools) {
    const address = String(pool.address ?? "");
    if (!address) continue;
    const tvlUsd = Number(pool.tvl);
    if (!Number.isFinite(tvlUsd)) continue;
    const side =
      pool.token_x?.address === mint ? "x" : pool.token_y?.address === mint ? "y" : undefined;
    if (!side) continue;
    if (!best || tvlUsd > best.tvlUsd) best = { address, tvlUsd, side };
  }
  return best;
}

export async function getMeteoraTvl(mint: string): Promise<MeteoraTvl> {
  const cached = getCache<MeteoraTvl>(cacheKey(mint), config.scan.meteoraCacheMs);
  if (cached) return { ...cached, available: cached.available ?? true };

  const results = await Promise.allSettled([
    fetchPools(DLMM_POOLS, mint),
    fetchPools(DAMM_POOLS, mint),
  ]);

  const seen = new Set<string>();
  let tvlUsd = 0;

  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("meteora fetch failed", String(result.reason));
      continue;
    }
    for (const pool of result.value) {
      const address = String(pool.address ?? "");
      if (address && seen.has(address)) continue;
      if (address) seen.add(address);
      tvlUsd += Number(pool.tvl) || 0;
    }
  }

  const dlmmPools = results[0]?.status === "fulfilled" ? results[0].value : [];
  const complete = results.every((result) => result.status === "fulfilled");
  const summary: MeteoraTvl = {
    tvlUsd,
    poolCount: seen.size,
    available: complete,
    topDlmm: topDlmmPool(dlmmPools, mint),
  };

  // Do not cache a total that lost one of the two endpoints to a timeout.
  if (complete) {
    setCache(cacheKey(mint), summary);
  }

  return summary;
}

interface OhlcvCacheEntry {
  expiresAt: number;
  candles: Candle[];
}

const ohlcvKey = (pool: DlmmPoolRef, resolution: string, limit: number) =>
  `ohlcv:meteora:${pool.address}:${pool.side}:${resolution}:${limit}`;

async function fetchOhlcvPage(
  address: string,
  timeframe: string,
  start: number,
  end: number,
): Promise<unknown> {
  const url = new URL(`${OHLCV_BASE}/${address}/ohlcv`);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("start_time", String(start));
  url.searchParams.set("end_time", String(end));

  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "gmgn-runner-alert/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`meteora ohlcv HTTP ${response.status}: ${raw.slice(0, 180)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`meteora ohlcv returned non-JSON: ${raw.slice(0, 180)}`);
  }
}

/**
 * Closed DLMM candles for `pool`, oriented to the watched mint.
 * Chunks stay at or under 50 candles. The snapshot is cached until the next
 * bar closes, capped by SUPERTREND_CACHE_MS.
 */
export async function getMeteoraOhlcv(
  pool: DlmmPoolRef,
  resolution: string,
  limit: number,
): Promise<Candle[]> {
  const timeframe = meteoraTimeframe(resolution);
  if (!timeframe) {
    throw new Error(`supertrend timeframe ${resolution} unsupported on Meteora DLMM`);
  }

  const resolutionMs = resolutionToMs(resolution);
  const barSec = Math.round(resolutionMs / 1000);
  const nowMs = Date.now();
  const key = ohlcvKey(pool, resolution, limit);
  const maxAgeMs = Math.max(config.supertrend.cacheMs, resolutionMs);

  if (config.supertrend.cacheMs > 0) {
    const cached = getCache<OhlcvCacheEntry>(key, maxAgeMs);
    if (cached && cached.expiresAt > nowMs && Array.isArray(cached.candles)) {
      return cached.candles;
    }
  }

  const endOpen = lastClosedOpenSec(Math.floor(nowMs / 1000), barSec);
  const ranges = planCandleRanges(endOpen, barSec, limit);
  const pages: Candle[][] = [];
  for (const range of ranges) {
    const payload = await paceOhlcv(() =>
      fetchOhlcvPage(pool.address, timeframe, range.start, range.end),
    );
    pages.push(parseMeteoraOhlcv(payload));
  }

  const merged = orientCandles(mergeCandles(pages), pool.side);
  const filled = fillCandleGaps(merged, barSec, endOpen, limit);
  const closed = selectClosedCandles(filled, resolutionMs, nowMs, limit);
  if (closed.length === 0) {
    throw new Error(`supertrend meteora empty (${pool.address})`);
  }

  if (config.supertrend.cacheMs > 0) {
    const entry: OhlcvCacheEntry = {
      expiresAt: nowMs + klineCacheTtlMs(nowMs, resolutionMs, config.supertrend.cacheMs),
      candles: closed,
    };
    setCache(key, entry);
  }
  return closed;
}
