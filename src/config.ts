import "dotenv/config";

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

const apiKey = process.env.GMGN_API_KEY?.trim() ?? "";
if (!apiKey) {
  throw new Error("GMGN_API_KEY is required. Copy .env.example to .env and fill it in.");
}

const chatIds = (process.env.TELEGRAM_CHAT_ID ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

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
    pollMs: num("POLL_INTERVAL_MS", 60_000),
    minAgeHours: num("MIN_AGE_HOURS", 48),
    minMarketCap: num("MIN_MARKET_CAP", 2_000_000),
    minTotalFeeSol: num("MIN_TOTAL_FEE_SOL", 60),
    /** price.volume_5m from token/info; 0 disables the filter. */
    minVol5mUsd: num("MIN_VOL5M_USD", 10_000),
    cooldownMs: num("COOLDOWN_MINUTES", 60) * 60_000,
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
    timezone: process.env.REPORT_TIMEZONE ?? "Asia/Jakarta",
    tzLabel: process.env.REPORT_TZ_LABEL ?? "WIB",
    maxChars: num("REPORT_MAX_CHARS", 3_500),
    maxTokensPerMessage: num("REPORT_MAX_TOKENS", 20),
  },
  dbPath: process.env.DB_PATH ?? "data/bot.db",
  dryRun: bool("DRY_RUN", false),
} as const;

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
    cooldownMinutes: config.scan.cooldownMs / 60_000,
    athTolerance: config.scan.athTolerance,
    infoCacheMs: config.scan.infoCacheMs,
    securityCacheMs: config.scan.securityCacheMs,
    meteoraCacheMs: config.scan.meteoraCacheMs,
    maxCandidatesPerCycle: config.scan.maxCandidatesPerCycle,
    pollMs: config.scan.pollMs,
    reportMode: config.report.mode,
    reportTimezone: config.report.timezone,
    dryRun: config.dryRun,
  };
}
