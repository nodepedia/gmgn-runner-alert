import { normalizeOpenTime, type Candle } from "./supertrend.js";

/**
 * Meteora DLMM pool price is token Y per 1 token X (the bin price,
 * `(1 + binStep/10000)^binId`, also exposed as `current_price`).
 * OHLCV on `/pools/{address}/ohlcv` is that same series, quoted in whatever
 * token Y is (SOL, USDC, or another mint). Trend only needs one consistent
 * pool, so USD conversion is unnecessary.
 *
 * When the watched mint is token X the series is already its price.
 * When it is token Y the series is inverted (`1/price`) so every candle is
 * the watched token priced in the other side of the same pool.
 */
export const METEORA_MAX_BARS = 50;

/** DLMM OHLCV intervals. `1d` is sent as `24h`. Others are GMGN-only. */
export function meteoraTimeframe(timeframe: string): string | undefined {
  switch (timeframe) {
    case "5m":
      return "5m";
    case "1h":
      return "1h";
    case "4h":
      return "4h";
    case "1d":
      return "24h";
    default:
      return undefined;
  }
}

/**
 * Open time of the last fully closed bar. A timestamp that lands on a
 * boundary belongs to the bar that just opened, so the previous bar is used.
 */
export function lastClosedOpenSec(nowSec: number, barSec: number): number {
  if (!(barSec > 0) || !Number.isFinite(nowSec)) return nowSec;
  const aligned = nowSec - (((nowSec % barSec) + barSec) % barSec);
  return aligned - barSec;
}

/**
 * Inclusive open-time windows, oldest first. Each window holds at most
 * `maxBars` candles, so a 5m chunk stays at or under the range Meteora
 * accepts (50×5m succeeds, 100×5m returns "time range too large").
 * Neighbouring windows share no timestamp.
 */
export function planCandleRanges(
  endOpenSec: number,
  barSec: number,
  count: number,
  maxBars = METEORA_MAX_BARS,
): Array<{ start: number; end: number }> {
  if (!(barSec > 0) || !Number.isFinite(endOpenSec)) return [];
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(maxBars) || maxBars < 1) {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let end = endOpenSec;
  let remaining = count;
  while (remaining > 0) {
    const take = Math.min(maxBars, remaining);
    const start = end - (take - 1) * barSec;
    ranges.push({ start, end });
    remaining -= take;
    end = start - barSec;
  }
  ranges.reverse();
  return ranges;
}

function asFinite(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parses `GET /pools/{address}/ohlcv` (`{ data: [{ timestamp, open, high, low, close, volume }] }`).
 * Rows with a non-positive price or high < low are dropped.
 */
export function parseMeteoraOhlcv(payload: unknown): Candle[] {
  const rows =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];

  const candles: Candle[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const time = normalizeOpenTime(item.timestamp);
    const open = asFinite(item.open);
    const high = asFinite(item.high);
    const low = asFinite(item.low);
    const close = asFinite(item.close);
    const volume = asFinite(item.volume);
    if (
      time === undefined ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined
    ) {
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) continue;
    candles.push({ time, open, high, low, close, volume: volume ?? 0 });
  }

  candles.sort((a, b) => a.time - b.time);
  return candles;
}

/** Oldest page first. A repeated timestamp keeps the later page's candle. */
export function mergeCandles(pages: readonly (readonly Candle[])[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const page of pages) {
    for (const candle of page) {
      if (!Number.isFinite(candle.time)) continue;
      byTime.set(candle.time, candle);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Price of token Y in token X. High and low swap because the reciprocal flips extremes. */
export function invertCandle(candle: Candle): Candle | null {
  const { open, high, low, close } = candle;
  if (!(open > 0 && high > 0 && low > 0 && close > 0) || high < low) return null;
  return {
    ...candle,
    open: 1 / open,
    high: 1 / low,
    low: 1 / high,
    close: 1 / close,
  };
}

export function orientCandles(candles: readonly Candle[], side: "x" | "y"): Candle[] {
  if (side === "x") return candles.map((candle) => ({ ...candle }));
  const inverted: Candle[] = [];
  for (const candle of candles) {
    const next = invertCandle(candle);
    if (next) inverted.push(next);
  }
  return inverted;
}

/**
 * Inserts missing bars between the first trade and `throughSec`.
 * A gap (no trades) copies the previous close into open/high/low/close and
 * sets volume to 0. Nothing is invented before the first real candle.
 * The walk keeps the most recent `maxBars` slots so a long history does not
 * push the latest bars out of the ATR window.
 */
export function fillCandleGaps(
  candles: readonly Candle[],
  resolutionSec: number,
  throughSec: number,
  maxBars: number,
): Candle[] {
  if (!(resolutionSec > 0) || !(maxBars > 0)) return [];

  const snapped = new Map<number, Candle>();
  for (const candle of candles) {
    if (!Number.isFinite(candle.time)) continue;
    const time = Math.round(candle.time / resolutionSec) * resolutionSec;
    snapped.set(time, { ...candle, time });
  }

  const times = [...snapped.keys()].sort((a, b) => a - b);
  if (times.length === 0) return [];

  const lastReal = times[times.length - 1];
  const through = Number.isFinite(throughSec)
    ? Math.round(throughSec / resolutionSec) * resolutionSec
    : lastReal;
  const end = Math.min(
    Math.max(lastReal, through),
    lastReal + (Math.floor(maxBars) - 1) * resolutionSec,
  );
  const start = Math.max(times[0], end - (Math.floor(maxBars) - 1) * resolutionSec);

  let prev = snapped.get(start);
  if (!prev) {
    for (let index = times.length - 1; index >= 0; index -= 1) {
      if (times[index] <= start) {
        prev = snapped.get(times[index]);
        break;
      }
    }
  }
  if (!prev) prev = snapped.get(times[0]);
  if (!prev) return [];

  const out: Candle[] = [];
  for (let time = start; time <= end; time += resolutionSec) {
    const found = snapped.get(time);
    if (found) {
      prev = found;
      out.push(found);
      continue;
    }
    out.push({
      time,
      open: prev.close,
      high: prev.close,
      low: prev.close,
      close: prev.close,
      volume: 0,
    });
  }
  return out;
}
