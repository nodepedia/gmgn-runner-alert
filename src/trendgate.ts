import { config } from "./config.js";
import { getTokenKline } from "./gmgn.js";
import { log } from "./logger.js";
import {
  decideTrend,
  resolutionToMs,
  selectClosedCandles,
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
): Promise<boolean> {
  if (!config.supertrend.enabled) return true;
  if (path === "watchlist" && !config.supertrend.watchlist) return true;

  try {
    return await evaluate(payload, path);
  } catch (error) {
    return finishUnavailable(
      payload,
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function evaluate(payload: AlertPayload, path: "runner" | "watchlist"): Promise<boolean> {
  const timeframe = config.supertrend.timeframe;
  const resolutionMs = resolutionToMs(timeframe);
  const fetched = await getTokenKline(payload.mint);
  // getTokenKline already drops the forming bar. Selecting again keeps the
  // decision on closed candles if a cached bar has since closed or not.
  const candles = selectClosedCandles(
    fetched,
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
    logReject(payload, path, decision);
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
): void {
  if (decision.reason === "supertrend bearish") {
    log.info(`supertrend bearish $${payload.symbol}`, {
      mint: payload.mint,
      path,
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
