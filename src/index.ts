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
import { initStrat, printEffectiveConfig, reloadStratIfChanged } from "./strat.js";
import { buildWatchlist } from "./report.js";
import {
  buildMessage,
  sendAlert,
  sendWatchlist,
  sendTestMessage,
  type AlertPayload,
} from "./telegram.js";

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

interface Evaluated {
  payload: AlertPayload;
  /** true = passes every filter including the runner volume threshold. */
  isRunner: boolean;
  state: {
    mint: string;
    symbol: string;
    marketCap: number;
    athMarketCap: number;
    tvlUsd: number;
  };
}

interface CycleStats {
  runners: number;
  /** Volume below MIN_WATCHLIST_VOL5M_USD: reported nowhere, logged only. */
  belowWatchlist: number;
  watchlistBuffered: number;
  watchlistSent: number;
  watchlistDropped: number;
  rejectedTvl: number;
}

/**
 * Tokens waiting for the next watchlist message, keyed by mint so a token that
 * stays in trending appears once per message with its freshest numbers.
 */
const watchlist = new Map<string, AlertPayload>();

function windowMs(): number {
  return config.report.windowMinutes * 60_000;
}

function currentBucket(): number {
  const span = windowMs();
  return span > 0 ? Math.floor(Date.now() / span) : 0;
}

let windowBucket = currentBucket();

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
    // Runner cooldown is applied after classification (see runCycle), so a
    // token inside its cooldown can still be evaluated for the watchlist.
    candidates.push({ item, mint, marketCap, ageSeconds });
  }

  return candidates;
}

/** Returns the evaluated token when it passes every hard filter, else null. */
async function evaluate(
  candidate: Candidate,
  stats: CycleStats,
): Promise<Evaluated | null> {
  const { mint } = candidate;

  // Free check first: if GMGN already told us this token is unsafe, do not
  // spend a single request on it.
  const cachedSecurity = peekTokenSecurity(mint);
  if (cachedSecurity && !evaluateSecurity(cachedSecurity).ok) return null;

  const info = await getTokenInfo(mint);
  const totalFeeSol = Number(info.total_fee ?? 0);
  if (totalFeeSol < config.scan.minTotalFeeSol) return null;

  const vol5mUsd = Number(info.price?.volume_5m ?? 0);
  // 5m volume no longer rejects: it separates real-time runners from the
  // every-N-minutes watchlist.
  const isRunner = config.scan.minVol5mUsd <= 0 || vol5mUsd >= config.scan.minVol5mUsd;

  // Below the watchlist floor the token is not reported at all. Checked before
  // Meteora and token/security, so quiet tokens cost no further requests.
  if (!isRunner && vol5mUsd < config.scan.minWatchlistVol5mUsd) {
    stats.belowWatchlist += 1;
    return null;
  }

  // Meteora is an external (non-GMGN) call, so it runs before the security
  // request: a TVL reject then costs no GMGN quota at all.
  const meteora = await getMeteoraTvl(mint);
  // Fail open: if Meteora could not be read, keep the token instead of
  // silently dropping a valid signal on an upstream outage.
  if (
    meteora.available &&
    config.scan.minTvlUsd > 0 &&
    meteora.tvlUsd < config.scan.minTvlUsd
  ) {
    stats.rejectedTvl += 1;
    log.debug(`tvl rejected $${String(candidate.item.symbol ?? mint)}`, {
      tvlUsd: Math.round(meteora.tvlUsd),
      min: config.scan.minTvlUsd,
      pools: meteora.poolCount,
    });
    return null;
  }

  const security = await getTokenSecurity(mint);
  const verdict = evaluateSecurity(security);
  if (!verdict.ok) {
    log.info(`security rejected $${String(candidate.item.symbol ?? mint)}`, {
      blacklist: verdict.blacklist,
      honeypot: verdict.honeypot,
      mintRenounced: verdict.mintRenounced,
      freezeRenounced: verdict.freezeRenounced,
    });
    return null;
  }

  const previousState = getState(mint);
  const previousAth = previousState?.last_ath_mc ?? 0;
  const historyAth = Number(candidate.item.history_highest_market_cap ?? 0);
  const atAth =
    historyAth > 0 &&
    candidate.marketCap >= historyAth * config.scan.athTolerance;

  const payload: AlertPayload = {
    mint,
    symbol: String(candidate.item.symbol ?? info.symbol ?? "?"),
    name: String(candidate.item.name ?? info.name ?? ""),
    marketCap: candidate.marketCap,
    ageSeconds: candidate.ageSeconds,
    totalFeeSol,
    vol5mUsd,
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

  return {
    payload,
    isRunner,
    state: {
      mint,
      symbol: payload.symbol,
      marketCap: candidate.marketCap,
      athMarketCap: historyAth,
      tvlUsd: meteora.tvlUsd,
    },
  };
}

/** Sends a runner immediately, then records it and drops it from the watchlist. */
async function deliverRunner(item: Evaluated): Promise<void> {
  if (config.dryRun) {
    console.log(buildMessage(item.payload));
    console.log("");
  } else {
    await sendAlert(item.payload);
  }

  // Recorded only after a successful send: a failed delivery is retried next
  // cycle instead of being lost.
  recordAlert(item.state);
  watchlist.delete(item.payload.mint);
}

/** Sends (or prints) the buffered watchlist and clears it. */
async function flushWatchlist(): Promise<{ sent: number; dropped: number }> {
  if (watchlist.size === 0) return { sent: 0, dropped: 0 };

  const all = [...watchlist.values()].sort((a, b) => b.vol5mUsd - a.vol5mUsd);
  const limit = Math.max(1, config.report.watchlistMax);
  const shown = all.slice(0, limit);
  const dropped = all.length - shown.length;
  watchlist.clear();

  try {
    if (config.dryRun) {
      console.log(buildWatchlist(shown, dropped).text);
      console.log("");
    } else {
      await sendWatchlist(shown, dropped);
    }
  } catch (error) {
    // Put everything back so the next window retries instead of losing tokens.
    for (const payload of all) {
      if (!watchlist.has(payload.mint)) watchlist.set(payload.mint, payload);
    }
    throw error;
  }

  return { sent: shown.length, dropped };
}

async function runCycle(options: { warmup?: boolean } = {}): Promise<void> {
  if (cycleRunning) {
    log.warn("previous cycle still running, skipping this tick");
    return;
  }
  cycleRunning = true;
  // Pick up strat.conf edits at the cycle boundary; the poll delay below uses
  // the value read at scheduling time, so a new POLL_INTERVAL_MS applies next.
  reloadStratIfChanged();
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

    const evaluated: Evaluated[] = [];
    const stats: CycleStats = {
      runners: 0,
      belowWatchlist: 0,
      watchlistBuffered: 0,
      watchlistSent: 0,
      watchlistDropped: 0,
      rejectedTvl: 0,
    };
    let errors = 0;

    for (const candidate of batch) {
      try {
        const result = await evaluate(candidate, stats);
        if (result) evaluated.push(result);
      } catch (error) {
        errors += 1;
        log.error(`candidate failed $${String(candidate.item.symbol ?? candidate.mint)}`, {
          mint: candidate.mint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (warmup) {
      for (const item of evaluated) {
        recordWarmup(item.state);
        log.info(`warmup seeded $${item.payload.symbol}`, { mint: item.state.mint });
      }
    } else {
      for (const item of evaluated) {
        if (item.isRunner) {
          if (!canAlert(item.payload.mint)) continue; // runner cooldown
          try {
            await deliverRunner(item);
            stats.runners += 1;
          } catch (error) {
            errors += 1;
            log.error(`runner delivery failed $${item.payload.symbol}`, {
              mint: item.payload.mint,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }

        // Watchlist is digest-only; individual mode keeps the old behaviour
        // of not reporting tokens below the volume threshold.
        if (config.report.mode === "digest") {
          watchlist.set(item.payload.mint, item.payload);
        }
      }

      stats.watchlistBuffered = watchlist.size;

      const span = windowMs();
      const bucket = currentBucket();
      const due = span <= 0 ? watchlist.size > 0 : bucket !== windowBucket;
      if (due) {
        windowBucket = bucket;
        if (watchlist.size > 0) {
          try {
            const flushed = await flushWatchlist();
            stats.watchlistSent = flushed.sent;
            stats.watchlistDropped = flushed.dropped;
          } catch (error) {
            log.error(
              "watchlist delivery failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
    }

    log.info("cycle done", {
      scanned: rank.length,
      eligible: eligible.length,
      batch: batch.length,
      runners: stats.runners,
      watchlist: watchlist.size,
      watchlistSent: stats.watchlistSent,
      watchlistDropped: stats.watchlistDropped,
      rejected: batch.length - evaluated.length - errors,
      rejectedTvl: stats.rejectedTvl,
      belowWatchlist: stats.belowWatchlist,
      errors,
      gapMs: pacer.currentGapMs,
      pollMs: config.scan.pollMs,
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

  initStrat();

  if (args.has("--show-config")) {
    printEffectiveConfig();
    return;
  }

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
    // Manual runs should show their result instead of waiting for a boundary.
    try {
      const flushed = await flushWatchlist();
      log.info("flushed on --once", flushed);
    } catch (error) {
      log.error("flush failed", error instanceof Error ? error.message : String(error));
    }
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
  if (config.report.mode === "digest") {
    log.info(
      `watchlist: one message every ${config.report.windowMinutes} minutes (max ${config.report.watchlistMax} tokens)`,
    );
  }
  loop();

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`, { watchlistPending: watchlist.size });
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
