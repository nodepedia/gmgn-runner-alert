import { config, summarizeConfig } from "./config.js";
import { log } from "./logger.js";
import {
  getTokenInfo,
  getTokenSecurity,
  getTrending,
  type RankItem,
} from "./gmgn.js";
import { getMeteoraTvl } from "./meteora.js";
import { canAlert, getState, recordAlert } from "./db.js";
import { buildMessage, sendAlert, sendTestMessage } from "./telegram.js";

let cycleRunning = false;

interface Candidate {
  item: RankItem;
  mint: string;
  marketCap: number;
  ageSeconds: number;
}

function collectCandidates(rank: RankItem[], nowSeconds: number): Candidate[] {
  const candidates: Candidate[] = [];

  for (const item of rank) {
    const mint = String(item.address ?? "");
    if (!mint) continue;

    const createdAt = Number(item.creation_timestamp ?? 0);
    if (createdAt <= 0) continue;

    const marketCap = Number(item.market_cap ?? 0);
    const ageSeconds = nowSeconds - createdAt;

    if (ageSeconds < config.scan.minAgeHours * 3_600) continue;
    if (marketCap < config.scan.minMarketCap) continue;
    if (!canAlert(mint)) continue;

    candidates.push({ item, mint, marketCap, ageSeconds });
  }

  return candidates;
}

async function runCycle(): Promise<void> {
  if (cycleRunning) {
    log.warn("previous cycle still running, skipping this tick");
    return;
  }
  cycleRunning = true;
  const startedAt = Date.now();

  try {
    const rank = await getTrending();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const eligible = collectCandidates(rank, nowSeconds);
    const batch = eligible.slice(0, config.scan.maxCandidatesPerCycle);

    let passedFee = 0;
    let alerts = 0;

    for (const candidate of batch) {
      const { mint } = candidate;

      const info = await getTokenInfo(mint, config.scan.feeCacheMs);
      const totalFeeSol = Number(info.total_fee ?? 0);
      if (totalFeeSol < config.scan.minTotalFeeSol) continue;

      passedFee += 1;

      const security = await getTokenSecurity(mint, config.scan.securityCacheMs);
      const blacklist = Number(security.blacklist ?? 0);
      const honeypot = Number(security.honeypot ?? 0);
      const mintRenounced = security.renounced_mint === true;
      const freezeRenounced = security.renounced_freeze_account === true;

      if (blacklist !== 0 || honeypot !== 0 || !mintRenounced || !freezeRenounced) {
        log.info(`security rejected ${candidate.item.symbol ?? mint}`, {
          blacklist,
          honeypot,
          mintRenounced,
          freezeRenounced,
        });
        continue;
      }

      // Refresh price/volume right before alerting; fee/security come from cache.
      const freshInfo = await getTokenInfo(mint, 60_000);
      const freshFee = Number(freshInfo.total_fee ?? 0);
      if (freshFee < config.scan.minTotalFeeSol) continue;

      const meteora = await getMeteoraTvl(mint);
      const previousState = getState(mint);
      const previousAth = previousState?.last_ath_mc ?? 0;
      const historyAth = Number(candidate.item.history_highest_market_cap ?? 0);
      const atAth =
        historyAth > 0 &&
        candidate.marketCap >= historyAth * config.scan.athTolerance;

      const payload = {
        mint,
        symbol: String(candidate.item.symbol ?? freshInfo.symbol ?? "?"),
        name: String(candidate.item.name ?? freshInfo.name ?? ""),
        marketCap: candidate.marketCap,
        ageSeconds: candidate.ageSeconds,
        totalFeeSol: freshFee,
        vol5mUsd: Number(freshInfo.price?.volume_5m ?? 0),
        tvlUsd: meteora.tvlUsd,
        poolCount: meteora.poolCount,
        ath: atAth
          ? {
              isNew: historyAth > previousAth,
              historyMarketCap: historyAth,
              previousMarketCap: previousAth,
            }
          : undefined,
      };

      if (config.dryRun) {
        log.info("dry run alert", { mint, symbol: payload.symbol });
        console.log(buildMessage(payload));
      } else {
        await sendAlert(payload);
        recordAlert({
          mint,
          symbol: payload.symbol,
          marketCap: candidate.marketCap,
          athMarketCap: historyAth,
          tvlUsd: meteora.tvlUsd,
        });
      }

      alerts += 1;
    }

    log.info("cycle done", {
      scanned: rank.length,
      eligible: eligible.length,
      batch: batch.length,
      passedFee,
      alerts,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    log.error("cycle failed", error instanceof Error ? error.message : String(error));
  } finally {
    cycleRunning = false;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  log.info("starting gmgn-runner-alert", summarizeConfig());

  if (args.has("--test")) {
    await sendTestMessage();
    return;
  }

  await runCycle();

  if (args.has("--once")) {
    log.info("single cycle finished (--once)");
    return;
  }

  const timer = setInterval(() => {
    void runCycle();
  }, config.scan.pollMs);

  log.info(`scheduler started, polling every ${config.scan.pollMs}ms`);

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    clearInterval(timer);
    setTimeout(() => process.exit(0), 250);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", reason instanceof Error ? reason.message : String(reason));
  });
}

void main();
