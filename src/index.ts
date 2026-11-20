import { config, summarizeConfig } from "./config.js";
import { log } from "./logger.js";
import {
  evaluateSecurity,
  getTokenInfo,
  getTokenSecurity,
  getTrending,
  peekTokenSecurity,
  pacer,
  type RankItem,
} from "./gmgn.js";
import { getMeteoraTvl } from "./meteora.js";
import { canAlert, getState, pruneCache, recordAlert, recordWarmup } from "./db.js";
import { buildMessage, sendAlert, sendTestMessage } from "./telegram.js";

let cycleRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Candidate {
  item: RankItem;
  mint: string;
  marketCap: number;
  ageSeconds: number;
}

type Outcome = "alert" | "warmup" | "rejected" | "error";

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

async function processCandidate(
  candidate: Candidate,
  warmup: boolean,
): Promise<Outcome> {
  const { mint } = candidate;

  // Free check first: if GMGN already told us this token is unsafe, do not
  // spend a single request on it.
  const cachedSecurity = peekTokenSecurity(mint);
  if (cachedSecurity && !evaluateSecurity(cachedSecurity).ok) {
    return "rejected";
  }

  const info = await getTokenInfo(mint);
  const totalFeeSol = Number(info.total_fee ?? 0);
  if (totalFeeSol < config.scan.minTotalFeeSol) return "rejected";

  const security = await getTokenSecurity(mint);
  const verdict = evaluateSecurity(security);
  if (!verdict.ok) {
    log.info(`security rejected $${String(candidate.item.symbol ?? mint)}`, {
      blacklist: verdict.blacklist,
      honeypot: verdict.honeypot,
      mintRenounced: verdict.mintRenounced,
      freezeRenounced: verdict.freezeRenounced,
    });
    return "rejected";
  }

  const meteora = await getMeteoraTvl(mint);
  const previousState = getState(mint);
  const previousAth = previousState?.last_ath_mc ?? 0;
  const historyAth = Number(candidate.item.history_highest_market_cap ?? 0);
  const atAth =
    historyAth > 0 &&
    candidate.marketCap >= historyAth * config.scan.athTolerance;

  const payload = {
    mint,
    symbol: String(candidate.item.symbol ?? info.symbol ?? "?"),
    name: String(candidate.item.name ?? info.name ?? ""),
    marketCap: candidate.marketCap,
    ageSeconds: candidate.ageSeconds,
    totalFeeSol,
    vol5mUsd: Number(info.price?.volume_5m ?? 0),
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

  const state = {
    mint,
    symbol: payload.symbol,
    marketCap: candidate.marketCap,
    athMarketCap: historyAth,
    tvlUsd: meteora.tvlUsd,
  };

  if (warmup) {
    recordWarmup(state);
    log.info(`warmup seeded $${payload.symbol}`, { mint });
    return "warmup";
  }

  if (config.dryRun) {
    log.info("dry run alert", { mint, symbol: payload.symbol });
    console.log(buildMessage(payload));
  } else {
    await sendAlert(payload);
  }

  // Recorded in dry run too, so flipping DRY_RUN=false does not replay a burst
  // of alerts for tokens the bot already surfaced while testing.
  recordAlert(state);
  return "alert";
}

async function runCycle(options: { warmup?: boolean } = {}): Promise<void> {
  if (cycleRunning) {
    log.warn("previous cycle still running, skipping this tick");
    return;
  }
  cycleRunning = true;
  const startedAt = Date.now();
  const warmup = options.warmup === true;

  try {
    const rank = await getTrending();
    // market/rank is the heaviest call in the cycle; give the IP bucket a
    // moment to refill before the per-token calls start.
    await sleep(config.gmgn.rankSettleMs);
    const nowSeconds = Math.floor(Date.now() / 1000);

    const eligible = collectCandidates(rank, nowSeconds);
    const batch = eligible.slice(0, config.scan.maxCandidatesPerCycle);

    const counts: Record<Outcome, number> = {
      alert: 0,
      warmup: 0,
      rejected: 0,
      error: 0,
    };

    for (const candidate of batch) {
      try {
        const outcome = await processCandidate(candidate, warmup);
        counts[outcome] += 1;
      } catch (error) {
        counts.error += 1;
        log.error(`candidate failed $${String(candidate.item.symbol ?? candidate.mint)}`, {
          mint: candidate.mint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log.info("cycle done", {
      scanned: rank.length,
      eligible: eligible.length,
      batch: batch.length,
      alerts: counts.alert,
      warmup: counts.warmup,
      rejected: counts.rejected,
      errors: counts.error,
      gapMs: pacer.currentGapMs,
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
  pruneCache();

  if (args.has("--test")) {
    await sendTestMessage();
    return;
  }

  if (args.has("--warmup")) {
    await runCycle({ warmup: true });
    log.info("warmup finished: current trending tokens recorded without alerts");
    return;
  }

  await runCycle();

  if (args.has("--once")) {
    log.info("single cycle finished (--once)");
    return;
  }

  let timer: NodeJS.Timeout | undefined;

  const loop = () => {
    timer = setTimeout(async () => {
      await runCycle();
      loop();
    }, config.scan.pollMs);
  };

  log.info(`scheduler started, polling every ${config.scan.pollMs}ms`);
  loop();

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    if (timer) clearTimeout(timer);
    setTimeout(() => process.exit(0), 250);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", reason instanceof Error ? reason.message : String(reason));
  });
}

void main();
