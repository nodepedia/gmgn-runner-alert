import { config } from "./config.js";
import { getTokenKline } from "./gmgn.js";
import { log } from "./logger.js";
import { getMeteoraOhlcv, type DlmmPoolRef } from "./meteora.js";
import {
  decideTrend,
  resolutionToMs,
  selectClosedCandles,
  type Candle,
  type TrendDecision,
} from "./supertrend.js";
import type { AlertPayload } from "./telegram.js";

/**
 * Runner (and, when enabled, watchlist) trend gate.
 *
 * Bullish: caller sends the alert and may start the runner cooldown.
 * Bearish or a failed candle read with SUPERTREND_ON_ERROR=skip: caller must
 * not send and must not record the alert, so a later flip can still notify
 * while volume is high.
 */
export async function applyTrendGate(
  payload: AlertPayload,
  path: "runner" | "watchlist",
  pool?: DlmmPoolRef,
): Promise<boolean> {
  if (!config.supertrend.enabled) return true;
  if (path === "watchlist" && !config.supertrend.watchlist) return true;

  try {
    return await evaluate(payload, path, pool);
  } catch (error) {
    return finishUnavailable(
      payload,
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function loadCandles(
  mint: string,
  pool: DlmmPoolRef | undefined,
): Promise<{ candles: Candle[]; source: "meteora" | "gmgn" }> {
  if (config.supertrend.source === "gmgn") {
    return { candles: await getTokenKline(mint), source: "gmgn" };
  }

  try {
    if (!pool) throw new Error("supertrend no dlmm pool");
    return {
      candles: await getMeteoraOhlcv(pool, config.supertrend.timeframe, config.supertrend.candles),
      source: "meteora",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!config.supertrend.fallbackGmgn) throw new Error(reason);
    log.warn("supertrend fallback gmgn", { mint, reason });
    return { candles: await getTokenKline(mint), source: "gmgn" };
  }
}

async function evaluate(
  payload: AlertPayload,
  path: "runner" | "watchlist",
  pool: DlmmPoolRef | undefined,
): Promise<boolean> {
  const timeframe = config.supertrend.timeframe;
  const resolutionMs = resolutionToMs(timeframe);
  const loaded = await loadCandles(payload.mint, pool);
  // Both sources already drop the forming bar. Selecting again keeps the
  // decision on closed candles if a cached bar has since closed or not.
  const candles = selectClosedCandles(
    loaded.candles,
    resolutionMs,
    Date.now(),
    config.supertrend.candles,
  );

  const decision = decideTrend({
    enabled: true,
    onError: config.supertrend.onError,
    period: config.supertrend.period,
    multiplier: config.supertrend.multiplier,
    candles,
  });

  if (!decision.send) {
    logReject(payload, path, decision, loaded.source);
    return false;
  }

  if (decision.reason) {
    log.warn(`supertrend allow $${payload.symbol}`, {
      mint: payload.mint,
      path,
      reason: decision.reason,
    });
  }

  if (path === "runner" && decision.tag) payload.trendTag = decision.tag;
  return true;
}

function finishUnavailable(
  payload: AlertPayload,
  path: "runner" | "watchlist",
  reason: string,
): boolean {
  if (config.supertrend.onError === "allow") {
    log.warn(`supertrend allow $${payload.symbol}`, { mint: payload.mint, path, reason });
    return true;
  }
  log.warn(`supertrend skip $${payload.symbol}`, { mint: payload.mint, path, reason });
  return false;
}

function logReject(
  payload: AlertPayload,
  path: "runner" | "watchlist",
  decision: TrendDecision,
  source: "meteora" | "gmgn",
): void {
  if (decision.reason === "supertrend bearish") {
    log.info(`supertrend bearish $${payload.symbol}`, {
      mint: payload.mint,
      path,
      source,
      timeframe: config.supertrend.timeframe,
      close: decision.close,
      supertrend: decision.line,
    });
    return;
  }
  log.warn(`supertrend skip $${payload.symbol}`, {
    mint: payload.mint,
    path,
    reason: decision.reason,
  });
}
