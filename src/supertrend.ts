/**
 * Supertrend (TradingView `ta.supertrend`) plus the candle helpers the runner
 * gate needs. This module is pure: no I/O, no config, no clock of its own.
 *
 * Bullish means trend up: the close sits above the supertrend line (the line
 * is the lower band). Bearish means trend down: the close sits below the line
 * (the line is the upper band). The ATR seed bar starts down, matching
 * TradingView, where `na(atr[1])` forces direction 1.
 */

export const SUPERTREND_TIMEFRAMES = ["30s", "1m", "5m", "15m", "1h", "4h", "1d"] as const;

export type SupertrendTimeframe = (typeof SUPERTREND_TIMEFRAMES)[number];

/** Short tag appended to a runner alert when the last closed candle is bullish. */
export const BULLISH_TAG = "ST 🟢 bullish";

export function isSupertrendTimeframe(value: string): value is SupertrendTimeframe {
  return (SUPERTREND_TIMEFRAMES as readonly string[]).includes(value);
}

export function resolutionToMs(timeframe: string): number {
  switch (timeframe) {
    case "30s":
      return 30_000;
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
    case "15m":
      return 900_000;
    case "1h":
      return 3_600_000;
    case "4h":
      return 14_400_000;
    case "1d":
      return 86_400_000;
    default:
      throw new Error(`unsupported supertrend timeframe: ${timeframe}`);
  }
}

export interface Candle {
  /** Open time, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SupertrendBar {
  index: number;
  atr: number;
  upperBand: number;
  lowerBand: number;
  /** Supertrend line. Bullish when close is above this value. */
  value: number;
  trend: "up" | "down";
  close: number;
}

export interface SupertrendResult {
  /** One entry per input candle. Bars before the ATR seed are null. */
  bars: Array<SupertrendBar | null>;
  /** Last bar that has a value, or null when the series is too short. */
  latest: SupertrendBar | null;
}

function assertParams(period: number, multiplier: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`supertrend period must be an integer >= 1, got ${period}`);
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`supertrend multiplier must be a finite number > 0, got ${multiplier}`);
  }
}

/**
 * Wilder ATR (Pine `ta.atr` / `ta.rma` of true range).
 * Index `period - 1` is the SMA of the first `period` true ranges; later bars
 * use `(prev * (period - 1) + tr) / period`. Earlier indexes are left unset.
 */
function wilderAtr(candles: readonly Pick<Candle, "high" | "low" | "close">[], period: number): number[] {
  const tr = new Array<number>(candles.length);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i += 1) {
    const prevClose = candles[i - 1].close;
    const { high, low } = candles[i];
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  const atr = new Array<number>(candles.length);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += tr[i];
  atr[period - 1] = seed / period;
  for (let i = period; i < candles.length; i += 1) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

export function computeSupertrend(
  candles: readonly Pick<Candle, "high" | "low" | "close">[],
  period: number,
  multiplier: number,
): SupertrendResult {
  assertParams(period, multiplier);

  const bars: Array<SupertrendBar | null> = new Array(candles.length).fill(null);
  if (candles.length < period) return { bars, latest: null };

  const atr = wilderAtr(candles, period);
  let prevUpper = 0;
  let prevLower = 0;
  let prevTrend: "up" | "down" | null = null;

  for (let i = period - 1; i < candles.length; i += 1) {
    const { high, low, close } = candles[i];
    const hl2 = (high + low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    let upper: number;
    let lower: number;
    let trend: "up" | "down";

    if (prevTrend === null) {
      upper = basicUpper;
      lower = basicLower;
      trend = "down";
    } else {
      const prevClose = candles[i - 1].close;
      lower = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
      upper = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
      trend = prevTrend === "down" ? (close > upper ? "up" : "down") : close < lower ? "down" : "up";
    }

    const bar: SupertrendBar = {
      index: i,
      atr: atr[i],
      upperBand: upper,
      lowerBand: lower,
      value: trend === "up" ? lower : upper,
      trend,
      close,
    };
    bars[i] = bar;
    prevUpper = upper;
    prevLower = lower;
    prevTrend = trend;
  }

  let latest: SupertrendBar | null = null;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i]) {
      latest = bars[i];
      break;
    }
  }
  return { bars, latest };
}

export interface TrendDecision {
  send: boolean;
  tag?: string;
  /** `supertrend bearish` blocks the send. Other reasons mean candles/params failed. */
  reason?: string;
  trend?: "up" | "down";
  close?: number;
  line?: number;
}

export function decideTrend(input: {
  enabled: boolean;
  onError: "skip" | "allow";
  period: number;
  multiplier: number;
  candles: readonly Pick<Candle, "high" | "low" | "close">[];
}): TrendDecision {
  if (!input.enabled) return { send: true };

  const unavailable = (reason: string): TrendDecision =>
    input.onError === "allow" ? { send: true, reason } : { send: false, reason };

  if (
    !Number.isInteger(input.period) ||
    input.period < 1 ||
    !Number.isFinite(input.multiplier) ||
    input.multiplier <= 0
  ) {
    return unavailable(
      `supertrend invalid parameters (period=${input.period}, multiplier=${input.multiplier})`,
    );
  }

  if (input.candles.length < input.period) {
    return unavailable(
      `supertrend insufficient candles (${input.candles.length} < ${input.period})`,
    );
  }

  const { latest } = computeSupertrend(input.candles, input.period, input.multiplier);
  if (!latest) {
    return unavailable(
      `supertrend insufficient candles (${input.candles.length} < ${input.period})`,
    );
  }

  if (latest.trend === "up") {
    return {
      send: true,
      tag: BULLISH_TAG,
      trend: "up",
      close: latest.close,
      line: latest.value,
    };
  }

  return {
    send: false,
    reason: "supertrend bearish",
    trend: "down",
    close: latest.close,
    line: latest.value,
  };
}

function asFinite(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** GMGN `time` is unix seconds. Values above 1e12 are treated as milliseconds. */
export function normalizeOpenTime(value: unknown): number | undefined {
  const parsed = asFinite(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

/**
 * Parses the GMGN `/v1/market/token_kline` payload (`{ list: [...] }` after the
 * client unwraps `data`, or a bare array). Rows are chronological.
 */
export function parseGmgnKline(payload: unknown): Candle[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { list?: unknown }).list)
      ? (payload as { list: unknown[] }).list
      : [];

  const candles: Candle[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const time = normalizeOpenTime(item.time);
    const open = asFinite(item.open);
    const high = asFinite(item.high);
    const low = asFinite(item.low);
    const close = asFinite(item.close);
    if (
      time === undefined ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined
    ) {
      continue;
    }
    if (high < low) continue;
    candles.push({ time, open, high, low, close });
  }

  candles.sort((a, b) => a.time - b.time);
  return candles;
}

/**
 * Drops candles that have not closed yet (`open + timeframe > now`) and keeps
 * the most recent `limit` closed candles. The forming bar is never used.
 */
export function selectClosedCandles(
  candles: readonly Candle[],
  resolutionMs: number,
  nowMs: number,
  limit?: number,
): Candle[] {
  if (!(resolutionMs > 0) || !Number.isFinite(nowMs)) return [];

  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const deduped: Candle[] = [];
  for (const candle of sorted) {
    if (!Number.isFinite(candle.time) || candle.time <= 0) continue;
    const last = deduped[deduped.length - 1];
    if (last && last.time === candle.time) deduped[deduped.length - 1] = candle;
    else deduped.push(candle);
  }

  const closed = deduped.filter((candle) => candle.time * 1000 + resolutionMs <= nowMs);
  if (limit !== undefined && limit > 0 && closed.length > limit) {
    return closed.slice(closed.length - limit);
  }
  return closed;
}

/**
 * Max age for a snapshot of already-closed candles. The snapshot goes stale
 * at the next bar close (a new closed candle appears), and never later than
 * `configuredMs`. `0` disables the cache.
 *
 * Callers must store an absolute expiry (`now + ttl`). Passing this duration
 * back in as a max-age on a later read would treat a previous bar's snapshot
 * as fresh, because the new bar has a long time-to-close.
 */
export function klineCacheTtlMs(nowMs: number, resolutionMs: number, configuredMs: number): number {
  if (!(configuredMs > 0) || !(resolutionMs > 0) || !Number.isFinite(nowMs)) return 0;
  const elapsed = ((nowMs % resolutionMs) + resolutionMs) % resolutionMs;
  const untilClose = elapsed === 0 ? resolutionMs : resolutionMs - elapsed;
  return Math.min(configuredMs, untilClose);
}
