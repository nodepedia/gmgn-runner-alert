import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BULLISH_TAG,
  computeSupertrend,
  decideTrend,
  klineCacheTtlMs,
  parseGmgnKline,
  selectClosedCandles,
  type Candle,
} from "./supertrend.js";

/**
 * Hand-computed fixture, period 2, multiplier 1.
 *
 * TR: 2, 2, 5, 3, 7
 * ATR: na, 2, 3.5, 3.25, 5.125
 * bar1 down 11 → bar2 flip up 9.5 → bar3 stay up 11.75 → bar4 flip down 14.125
 */
const FLIP: Array<Pick<Candle, "high" | "low" | "close">> = [
  { high: 10, low: 8, close: 9 },
  { high: 10, low: 8, close: 9 },
  { high: 14, low: 12, close: 13 },
  { high: 16, low: 14, close: 15 },
  { high: 10, low: 8, close: 8 },
];

function assertBar(
  bar: { trend: string; value: number; close: number } | null,
  trend: "up" | "down",
  value: number,
): void {
  assert.ok(bar, "expected a supertrend bar");
  assert.equal(bar.trend, trend);
  assert.equal(bar.value, value);
  if (trend === "up") assert.ok(bar.close > bar.value);
  else assert.ok(bar.close < bar.value);
}

describe("computeSupertrend", () => {
  it("matches the known flip fixture, including both direction changes", () => {
    const { bars, latest } = computeSupertrend(FLIP, 2, 1);

    assert.equal(bars[0], null);
    assertBar(bars[1], "down", 11);
    assert.equal(bars[1]?.atr, 2);
    assertBar(bars[2], "up", 9.5);
    assert.equal(bars[2]?.atr, 3.5);
    assertBar(bars[3], "up", 11.75);
    assert.equal(bars[3]?.atr, 3.25);
    assertBar(bars[4], "down", 14.125);
    assert.equal(bars[4]?.atr, 5.125);
    assert.equal(latest?.index, 4);
    assert.equal(latest?.trend, "down");
  });

  it("returns no values when there are fewer candles than the ATR period", () => {
    const { bars, latest } = computeSupertrend(FLIP.slice(0, 9), 10, 3);
    assert.equal(latest, null);
    assert.equal(bars.length, 5);
    assert.deepEqual(bars, [null, null, null, null, null]);
  });

  it("returns no values for an empty series", () => {
    const { bars, latest } = computeSupertrend([], 10, 3);
    assert.equal(latest, null);
    assert.deepEqual(bars, []);
  });

  it("rejects a non-positive period or multiplier", () => {
    assert.throws(() => computeSupertrend(FLIP, 0, 3), /period/);
    assert.throws(() => computeSupertrend(FLIP, 1.5, 3), /period/);
    assert.throws(() => computeSupertrend(FLIP, 10, 0), /multiplier/);
    assert.throws(() => computeSupertrend(FLIP, 10, Number.NaN), /multiplier/);
  });

  it("stays bearish on a flat series and reads the last bar", () => {
    const flat = Array.from({ length: 12 }, () => ({ high: 11, low: 9, close: 10 }));
    const { bars, latest } = computeSupertrend(flat, 10, 3);
    assert.equal(bars.slice(0, 9).every((bar) => bar === null), true);
    assert.ok(latest);
    assert.equal(latest.index, 11);
    assert.equal(latest.trend, "down");
    assert.equal(latest.value, 16);
    assert.ok(latest.close < latest.value);
  });
});

describe("decideTrend", () => {
  const base = {
    enabled: true,
    onError: "skip" as const,
    period: 2,
    multiplier: 1,
  };

  it("sends a bullish runner with the trend tag", () => {
    const decision = decideTrend({ ...base, candles: FLIP.slice(0, 3) });
    assert.equal(decision.send, true);
    assert.equal(decision.trend, "up");
    assert.equal(decision.tag, BULLISH_TAG);
    assert.equal(decision.tag, "ST 🟢 bullish");
    assert.equal(decision.reason, undefined);
  });

  it("blocks a bearish runner and does not invent a tag", () => {
    const decision = decideTrend({ ...base, candles: FLIP });
    assert.equal(decision.send, false);
    assert.equal(decision.reason, "supertrend bearish");
    assert.equal(decision.trend, "down");
    assert.equal(decision.tag, undefined);
    assert.equal(decision.line, 14.125);
    assert.equal(decision.close, 8);
  });

  it("skips when candles are insufficient and onError is skip", () => {
    const decision = decideTrend({
      enabled: true,
      onError: "skip",
      period: 10,
      multiplier: 3,
      candles: FLIP,
    });
    assert.equal(decision.send, false);
    assert.equal(decision.reason, "supertrend insufficient candles (5 < 10)");
    assert.equal(decision.tag, undefined);
  });

  it("allows the alert without a tag when candles are insufficient and onError is allow", () => {
    const decision = decideTrend({
      enabled: true,
      onError: "allow",
      period: 10,
      multiplier: 3,
      candles: [],
    });
    assert.equal(decision.send, true);
    assert.equal(decision.tag, undefined);
    assert.match(decision.reason ?? "", /insufficient candles \(0 < 10\)/);
  });

  it("does not gate when the feature is disabled, even if the series is bearish", () => {
    const decision = decideTrend({ ...base, enabled: false, candles: FLIP });
    assert.deepEqual(decision, { send: true });
  });
});

describe("parseGmgnKline", () => {
  it("reads the list payload, coerces strings, and sorts by open time", () => {
    const candles = parseGmgnKline({
      list: [
        { time: 200, open: "2", high: "4", low: "1", close: "3", volume: "9", amount: "12" },
        { time: "100", open: "1", high: "2", low: "0.5", close: "1.5" },
        { time: 300, open: "nope", high: "1", low: "1", close: "1" },
        { time: 400, open: "1", high: "1", low: "2", close: "1" },
      ],
    });
    assert.deepEqual(candles, [
      { time: 100, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 200, open: 2, high: 4, low: 1, close: 3 },
    ]);
  });

  it("accepts a bare array and normalizes millisecond open times", () => {
    const candles = parseGmgnKline([
      { time: 1_700_000_000_000, open: 1, high: 2, low: 1, close: 2 },
    ]);
    assert.equal(candles[0]?.time, 1_700_000_000);
  });

  it("returns an empty list for an unusable payload", () => {
    assert.deepEqual(parseGmgnKline(null), []);
    assert.deepEqual(parseGmgnKline({ list: "nope" }), []);
    assert.deepEqual(parseGmgnKline({}), []);
  });
});

describe("selectClosedCandles", () => {
  const start = 1_700_000_000;
  const bar = 60;

  const closed = FLIP.map((candle, index) => ({
    ...candle,
    time: start + index * bar,
    open: candle.close,
  }));

  // A still-open rally that would flip the down series back to bullish.
  const rally: Candle = {
    time: start + 5 * bar,
    open: 8,
    high: 30,
    low: 20,
    close: 28,
  };

  it("drops the forming candle so the decision stays on the last closed bar", () => {
    const nowMs = rally.time * 1000 + 1_000;
    const selected = selectClosedCandles([...closed, rally], bar * 1000, nowMs);

    assert.equal(selected.length, closed.length);
    assert.equal(selected.at(-1)?.time, closed.at(-1)?.time);

    const usingClosed = decideTrend({
      enabled: true,
      onError: "skip",
      period: 2,
      multiplier: 1,
      candles: selected,
    });
    assert.equal(usingClosed.send, false);
    assert.equal(usingClosed.reason, "supertrend bearish");

    const usingFormingBar = decideTrend({
      enabled: true,
      onError: "skip",
      period: 2,
      multiplier: 1,
      candles: [...closed, rally],
    });
    assert.equal(usingFormingBar.send, true);
    assert.equal(usingFormingBar.trend, "up");
  });

  it("keeps a candle once its timeframe has fully elapsed", () => {
    const last = closed.at(-1)!;
    const nowMs = last.time * 1000 + bar * 1000;
    const selected = selectClosedCandles(closed, bar * 1000, nowMs);
    assert.equal(selected.at(-1)?.time, last.time);
  });

  it("keeps the last duplicate open time and honours the limit", () => {
    const nowMs = (start + 4 * bar) * 1000 + bar * 1000;
    const withDuplicate = [
      closed[0],
      { ...closed[0], close: 9.5, high: 10, low: 8 },
      ...closed.slice(1),
    ];
    const deduped = selectClosedCandles(withDuplicate, bar * 1000, nowMs);
    assert.equal(deduped.length, closed.length);
    assert.equal(deduped[0]?.close, 9.5);

    const limited = selectClosedCandles(withDuplicate, bar * 1000, nowMs, 2);
    assert.equal(limited.length, 2);
    assert.equal(limited[0]?.time, closed[3]?.time);
    assert.equal(limited[1]?.time, closed[4]?.time);
  });
});

describe("klineCacheTtlMs", () => {
  const bar = 300_000;

  it("expires at the next close and never past the configured cap", () => {
    assert.equal(klineCacheTtlMs(1_000_000, bar, 0), 0);
    assert.equal(klineCacheTtlMs(bar * 10, bar, 240_000), 240_000);
    const tenSecondsIn = bar * 10 + 10_000;
    assert.equal(klineCacheTtlMs(tenSecondsIn, bar, 240_000), 240_000);
    assert.equal(klineCacheTtlMs(tenSecondsIn, bar, 400_000), bar - 10_000);
  });
});
