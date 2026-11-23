import "dotenv/config";
import { isSupertrendTimeframe, SUPERTREND_TIMEFRAMES } from "./supertrend.js";

export type ReportMode = "digest" | "individual";
export type SupertrendOnError = "skip" | "allow";

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${key}: ${raw}`);
  }
  return parsed;
}

function bool(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function intInRange(key: string, fallback: number, min: number, max: number): number {
  const value = num(key, fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${key}: ${value} (whole number ${min}..${max})`);
  }
  return value;
}

function floatInRange(key: string, fallback: number, min: number, max: number): number {
  const value = num(key, fallback);
  if (value < min || value > max) {
    throw new Error(`Invalid ${key}: ${value} (${min}..${max})`);
  }
  return value;
}

function supertrendTimeframe(): string {
  const raw = process.env.SUPERTREND_TIMEFRAME?.trim();
  if (!raw) return "5m";
  if (!isSupertrendTimeframe(raw)) {
    throw new Error(
      `Invalid SUPERTREND_TIMEFRAME: ${raw} (use ${SUPERTREND_TIMEFRAMES.join(", ")})`,
    );
  }
  return raw;
}

function supertrendOnError(): SupertrendOnError {
  const raw = process.env.SUPERTREND_ON_ERROR?.trim().toLowerCase();
  if (!raw) return "skip";
  if (raw === "skip" || raw === "allow") return raw;
  throw new Error(`Invalid SUPERTREND_ON_ERROR: ${raw} (use skip or allow)`);
}

const apiKey = process.env.GMGN_API_KEY?.trim() ?? "";
if (!apiKey) {
  throw new Error("GMGN_API_KEY is required. Copy .env.example to .env and fill it in.");
}

const chatIds = (process.env.TELEGRAM_CHAT_ID ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const cooldownMinutes = num("COOLDOWN_MINUTES", 60);

/**
 * Every field is intentionally mutable: src/strat.ts re-applies strat.conf at
 * runtime, so editing that file changes behaviour without a redeploy.
 * Values loaded here are the defaults (.env or built-in).
 */
export const config = {
  gmgn: {
    apiKey,
    baseUrl: process.env.GMGN_BASE_URL ?? "https://openapi.gmgn.ai",
    /**
     * Measured on the production VPS: the IP bucket holds ~5 units and refills
     * at roughly 1 unit per second, so anything above 1 request/second drains
     * it and earns a 30s ban. One request in flight, 1000ms apart, ran 4 cold
     * cycles back to back (84 requests) with zero 429s.
     */
    minGapMs: num("GMGN_MIN_GAP_MS", 1_000),
    maxGapMs: num("GMGN_MAX_GAP_MS", 5_000),
    /** market/rank is heavy (weight ~3) and drains the bucket; let it refill. */
    rankSettleMs: num("GMGN_RANK_SETTLE_MS", 800),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    chatIds,
  },
  scan: {
    interval: process.env.TRENDING_INTERVAL ?? "5m",
    limit: num("TRENDING_LIMIT", 100),
    orderBy: process.env.TRENDING_ORDER_BY ?? "volume",
    pollMs: num("POLL_INTERVAL_MS", 30_000),
    minAgeHours: num("MIN_AGE_HOURS", 48),
    minMarketCap: num("MIN_MARKET_CAP", 2_000_000),
    minTotalFeeSol: num("MIN_TOTAL_FEE_SOL", 60),
    /** price.volume_5m from token/info; runner threshold; 0 = every token runs. */
    minVol5mUsd: num("MIN_VOL5M_USD", 30_000),
    /** Floor for the watchlist; below this the token is dropped entirely. */
    minWatchlistVol5mUsd: num("MIN_WATCHLIST_VOL5M_USD", 5_000),
    /** Meteora DLMM + DAMM v2 TVL; 0 disables the filter. */
    minTvlUsd: num("MIN_TVL_USD", 20_000),
    /** Runner cooldown; the watchlist deliberately ignores it. */
    cooldownMinutes,
    cooldownMs: cooldownMinutes * 60_000,
    athTolerance: num("ATH_TOLERANCE", 0.995),
    /** token/info holds total_fee + volume_5m; one fetch per cycle is enough. */
    infoCacheMs: num("INFO_CACHE_MS", 55_000),
    /** token/security barely changes; keep it for an hour. */
    securityCacheMs: num("SECURITY_CACHE_MS", 3_600_000),
    /** Meteora TVL is only used for display. */
    meteoraCacheMs: num("METEORA_CACHE_MS", 300_000),
    maxCandidatesPerCycle: num("MAX_CANDIDATES_PER_CYCLE", 25),
  },
  report: {
    /** digest = one message per cycle, individual = one message per token. */
    mode: (process.env.REPORT_MODE ?? "digest").trim().toLowerCase() === "individual"
      ? ("individual" as const)
      : ("digest" as const),
    /** Watchlist digest cadence; 0 = flush it every cycle. */
    windowMinutes: num("REPORT_WINDOW_MINUTES", 30),
    /** Max tokens per watchlist message (runner alerts are never capped). */
    watchlistMax: num("WATCHLIST_MAX", 20),
    timezone: process.env.REPORT_TIMEZONE ?? "Asia/Jakarta",
    tzLabel: process.env.REPORT_TZ_LABEL ?? "WIB",
  },
  /**
   * Runner trend gate. Candle source is GMGN `GET /v1/market/token_kline`
   * (gmgn-cli `OpenApiClient.getTokenKline`), paced by the shared GMGN pacer.
   */
  supertrend: {
    enabled: bool("SUPERTREND_ENABLED", true),
    period: intInRange("SUPERTREND_PERIOD", 10, 1, 200),
    multiplier: floatInRange("SUPERTREND_MULTIPLIER", 3, 0.1, 100),
    timeframe: supertrendTimeframe(),
    /** Closed candles requested. The forming bar is not counted. */
    candles: intInRange("SUPERTREND_CANDLES", 100, 10, 500),
    /** skip = don't alert when candles fail; allow = send the runner anyway. */
    onError: supertrendOnError(),
    /** Off: the watchlist ignores Supertrend. On: same bullish gate as runners. */
    watchlist: bool("SUPERTREND_WATCHLIST", false),
    /**
     * Upper bound on how long a closed-candle snapshot is reused. The effective
     * TTL is also capped to the next bar close. 0 disables the cache.
     */
    cacheMs: intInRange("SUPERTREND_CACHE_MS", 240_000, 0, 3_600_000),
  },
  dbPath: process.env.DB_PATH ?? "data/bot.db",
  dryRun: bool("DRY_RUN", false),
};

export function summarizeConfig() {
  return {
    gmgnBaseUrl: config.gmgn.baseUrl,
    gmgnApiKey: `${config.gmgn.apiKey.slice(0, 6)}…`,
    gmgnGapMs: config.gmgn.minGapMs,
    gmgnRankSettleMs: config.gmgn.rankSettleMs,
    telegram: config.telegram.token ? "configured" : "MISSING",
    chatIds: config.telegram.chatIds.length > 0 ? config.telegram.chatIds : "MISSING",
    interval: config.scan.interval,
    limit: config.scan.limit,
    minAgeHours: config.scan.minAgeHours,
    minMarketCap: config.scan.minMarketCap,
    minTotalFeeSol: config.scan.minTotalFeeSol,
    minVol5mUsd: config.scan.minVol5mUsd,
    minWatchlistVol5mUsd: config.scan.minWatchlistVol5mUsd,
    minTvlUsd: config.scan.minTvlUsd,
    cooldownMinutes: config.scan.cooldownMinutes,
    athTolerance: config.scan.athTolerance,
    infoCacheMs: config.scan.infoCacheMs,
    securityCacheMs: config.scan.securityCacheMs,
    meteoraCacheMs: config.scan.meteoraCacheMs,
    maxCandidatesPerCycle: config.scan.maxCandidatesPerCycle,
    pollMs: config.scan.pollMs,
    reportMode: config.report.mode,
    reportWindowMinutes: config.report.windowMinutes,
    watchlistMax: config.report.watchlistMax,
    reportTimezone: config.report.timezone,
    dryRun: config.dryRun,
    supertrend: config.supertrend.enabled,
    supertrendPeriod: config.supertrend.period,
    supertrendMultiplier: config.supertrend.multiplier,
    supertrendTimeframe: config.supertrend.timeframe,
    supertrendCandles: config.supertrend.candles,
    supertrendOnError: config.supertrend.onError,
    supertrendWatchlist: config.supertrend.watchlist,
    supertrendCacheMs: config.supertrend.cacheMs,
    supertrendSource: "gmgn:/v1/market/token_kline",
  };
}
