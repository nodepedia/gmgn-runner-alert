import { log } from "./logger.js";

export interface MeteoraTvl {
  tvlUsd: number;
  poolCount: number;
}

interface MeteoraPool {
  address?: string;
  tvl?: number | string;
  is_blacklisted?: boolean;
  token_x?: { address?: string };
  token_y?: { address?: string };
  [key: string]: unknown;
}

const ENDPOINTS = [
  "https://dlmm.datapi.meteora.ag/pools",
  "https://damm-v2.datapi.meteora.ag/pools",
] as const;

const MAX_PAGES = 10;

async function fetchPools(endpoint: string, mint: string): Promise<MeteoraPool[]> {
  const matched: MeteoraPool[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${endpoint}?query=${encodeURIComponent(mint)}&page_size=100&page=${page}`;
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

export async function getMeteoraTvl(mint: string): Promise<MeteoraTvl> {
  const results = await Promise.allSettled(
    ENDPOINTS.map((endpoint) => fetchPools(endpoint, mint)),
  );

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

  return { tvlUsd, poolCount: seen.size };
}
