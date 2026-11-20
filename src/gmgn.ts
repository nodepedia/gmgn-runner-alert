import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";

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

const WEIGHTS = {
  rank: 3,
  info: 1,
  security: 1,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
  }

  async take(weight: number): Promise<void> {
    if (weight > this.capacity) {
      throw new Error(`Request weight ${weight} exceeds bucket capacity ${this.capacity}`);
    }
    for (;;) {
      const now = Date.now();
      const elapsedSeconds = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSeconds * this.ratePerSecond,
      );
      this.lastRefill = now;

      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }

      const deficit = weight - this.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSecond) * 1000) + 25;
      await sleep(waitMs);
    }
  }
}

const bucket = new TokenBucket(config.gmgn.ratePerSecond, config.gmgn.burst);

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

async function request(
  path: string,
  params: Record<string, string | number>,
  weight: number,
  attempt = 0,
): Promise<unknown> {
  await bucket.take(weight);

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
    throw new Error(`GMGN ${path} returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`);
  }

  const code = Number(json.code ?? 0);
  const resetAt = Number(json.reset_at ?? response.headers.get("x-ratelimit-reset") ?? 0);

  if (response.status === 429 || code === 429) {
    if (attempt < 2) {
      const waitMs = resetAt
        ? Math.max(1_000, resetAt * 1000 - Date.now() + 1_000)
        : 5_000;
      const capped = Math.min(waitMs, 120_000);
      log.warn(`GMGN rate limited on ${path}, waiting ${Math.round(capped / 1000)}s`);
      await sleep(capped);
      return request(path, params, weight, attempt + 1);
    }
    throw new Error(`GMGN rate limited on ${path}`);
  }

  if (!response.ok) {
    throw new Error(`GMGN ${path} HTTP ${response.status}: ${raw.slice(0, 200)}`);
  }

  if (code !== 0) {
    const message = String(json.message ?? json.error ?? "");
    throw new Error(`GMGN ${path} code=${code}: ${message}`);
  }

  return unwrap(json);
}

export async function getTrending(): Promise<RankItem[]> {
  const data = await request(
    "/v1/market/rank",
    {
      chain: "sol",
      interval: config.scan.interval,
      limit: config.scan.limit,
      order_by: config.scan.orderBy,
      direction: "desc",
    },
    WEIGHTS.rank,
  );

  const rank = (data as { rank?: unknown })?.rank;
  return Array.isArray(rank) ? (rank as RankItem[]) : [];
}

interface CacheEntry<T> {
  value: T;
  at: number;
}

const infoCache = new Map<string, CacheEntry<TokenInfo>>();
const securityCache = new Map<string, CacheEntry<TokenSecurity>>();

export async function getTokenInfo(mint: string, maxAgeMs = 0): Promise<TokenInfo> {
  const cached = infoCache.get(mint);
  if (maxAgeMs > 0 && cached && Date.now() - cached.at <= maxAgeMs) {
    return cached.value;
  }

  const value = (await request(
    "/v1/token/info",
    { chain: "sol", address: mint },
    WEIGHTS.info,
  )) as TokenInfo;

  infoCache.set(mint, { value, at: Date.now() });
  return value;
}

export async function getTokenSecurity(
  mint: string,
  maxAgeMs = 0,
): Promise<TokenSecurity> {
  const cached = securityCache.get(mint);
  if (maxAgeMs > 0 && cached && Date.now() - cached.at <= maxAgeMs) {
    return cached.value;
  }

  const value = (await request(
    "/v1/token/security",
    { chain: "sol", address: mint },
    WEIGHTS.security,
  )) as TokenSecurity;

  securityCache.set(mint, { value, at: Date.now() });
  return value;
}
