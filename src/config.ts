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
    ratePerSecond: num("GMGN_RATE_PER_SEC", 5),
    burst: num("GMGN_BURST", 5),
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
    cooldownMs: num("COOLDOWN_MINUTES", 60) * 60_000,
    athTolerance: num("ATH_TOLERANCE", 0.995),
    feeCacheMs: num("FEE_CACHE_MS", 10 * 60_000),
    securityCacheMs: num("SECURITY_CACHE_MS", 60 * 60_000),
    maxCandidatesPerCycle: num("MAX_CANDIDATES_PER_CYCLE", 30),
  },
  dbPath: process.env.DB_PATH ?? "data/bot.db",
  dryRun: bool("DRY_RUN", false),
} as const;

export function summarizeConfig() {
  return {
    gmgnBaseUrl: config.gmgn.baseUrl,
    gmgnApiKey: `${config.gmgn.apiKey.slice(0, 6)}…`,
    telegram: config.telegram.token ? "configured" : "MISSING",
    chatIds: config.telegram.chatIds.length > 0 ? config.telegram.chatIds : "MISSING",
    interval: config.scan.interval,
    limit: config.scan.limit,
    minAgeHours: config.scan.minAgeHours,
    minMarketCap: config.scan.minMarketCap,
    minTotalFeeSol: config.scan.minTotalFeeSol,
    cooldownMinutes: config.scan.cooldownMs / 60_000,
    athTolerance: config.scan.athTolerance,
    feeCacheMs: config.scan.feeCacheMs,
    securityCacheMs: config.scan.securityCacheMs,
    maxCandidatesPerCycle: config.scan.maxCandidatesPerCycle,
    pollMs: config.scan.pollMs,
    dryRun: config.dryRun,
  };
}
