import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fillCandleGaps,
  invertCandle,
  lastClosedOpenSec,
  mergeCandles,
  meteoraTimeframe,
  orientCandles,
  parseMeteoraOhlcv,
  planCandleRanges,
  METEORA_MAX_BARS,
} from "./ohlcv.js";
import { computeSupertrend, type Candle } from "./supertrend.js";

const FIXTURE = {
  start_time: 1_700_000_000,
  end_time: 1_700_000_600,
  timeframe: "5m",
  data: [
    {
      timestamp: 1_700_000_300,
      timestamp_str: "2023-11-14 22:25:00",
      open: 2,
      high: 4,
      low: 1,
      close: 3,
      volume: 9,
    },
    {
      timestamp: 1_700_000_000,
      timestamp_str: "2023-11-14 22:20:00",
      open: "1.5",
      high: "2",
      low: "1",
      close: "1.8",
      volume: "4",
    },
    {
      timestamp: 1_700_000_600,
      timestamp_str: "bad",
      open: 0,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    },
  ],
};

describe("parseMeteoraOhlcv", () => {
  it("reads the DLMM payload, sorts by timestamp, and drops non-positive prices", () => {
    const candles = parseMeteoraOhlcv(FIXTURE);
    assert.deepEqual(
      candles.map((candle) => [candle.time, candle.close, candle.volume]),
      [
        [1_700_000_000, 1.8, 4],
        [1_700_000_300, 3, 9],
      ],
    );
    assert.equal(candles[1]?.high, 4);
    assert.equal(candles[1]?.low, 1);
  });

  it("returns nothing for an error body or a missing data array", () => {
    assert.deepEqual(parseMeteoraOhlcv({ message: "time range too large" }), []);
    assert.deepEqual(parseMeteoraOhlcv(null), []);
    assert.deepEqual(parseMeteoraOhlcv({ data: "nope" }), []);
  });
});

describe("planCandleRanges", () => {
  const end = 1_700_000_000;
  const bar = 300;

  it("splits 100 candles into two chunks of 50 with no shared timestamp", () => {
    const ranges = planCandleRanges(end, bar, 100, METEORA_MAX_BARS);
    assert.equal(ranges.length, 2);
    for (const range of ranges) {
      const candles = (range.end - range.start) / bar + 1;
      assert.equal(candles, 50);
      assert.ok(range.end - range.start <= 49 * bar);
    }
    assert.equal(ranges[0]?.end, (ranges[1]?.start ?? 0) - bar);
    assert.equal(ranges[1]?.end, end);
    assert.equal(ranges[0]?.start, end - 99 * bar);
  });

  it("uses two requests for the default 60-candle window", () => {
    const ranges = planCandleRanges(end, bar, 60, 50);
    assert.equal(ranges.length, 2);
    assert.equal((ranges[0]!.end - ranges[0]!.start) / bar + 1, 10);
    assert.equal((ranges[1]!.end - ranges[1]!.start) / bar + 1, 50);
    assert.equal(ranges[1]?.end, end);
  });
});

describe("mergeCandles", () => {
  it("dedupes an overlapping page by timestamp and keeps the later page", () => {
    const older: Candle[] = [
      { time: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: 200, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const newer: Candle[] = [
      { time: 200, open: 2, high: 4, low: 2, close: 3, volume: 8 },
      { time: 300, open: 3, high: 3, low: 3, close: 3, volume: 2 },
    ];
    const merged = mergeCandles([older, newer]);
    assert.deepEqual(
      merged.map((candle) => [candle.time, candle.close]),
      [
        [100, 1],
        [200, 3],
        [300, 3],
      ],
    );
  });
});

describe("orientCandles", () => {
  const raw: Candle = { time: 1, open: 2, high: 4, low: 1, close: 2, volume: 5 };

  it("leaves token_x prices untouched", () => {
    assert.deepEqual(orientCandles([raw], "x"), [raw]);
  });

  it("inverts token_y prices and swaps high with low", () => {
    const [candle] = orientCandles([raw], "y");
    assert.ok(candle);
    assert.equal(candle.open, 0.5);
    assert.equal(candle.close, 0.5);
    assert.equal(candle.high, 1);
    assert.equal(candle.low, 0.25);
    assert.ok(candle.high >= candle.low);
    assert.equal(candle.volume, 5);
    assert.equal(invertCandle({ ...raw, open: 0 }), null);
  });
});

describe("fillCandleGaps", () => {
  it("forward-fills a missing bar with the previous close and zero volume", () => {
    const filled = fillCandleGaps(
      [
        { time: 0, open: 1, high: 2, low: 1, close: 1.5, volume: 10 },
        { time: 600, open: 1.5, high: 3, low: 1.4, close: 2, volume: 4 },
      ],
      300,
      600,
      10,
    );
    assert.equal(filled.length, 3);
    assert.deepEqual(filled[1], {
      time: 300,
      open: 1.5,
      high: 1.5,
      low: 1.5,
      close: 1.5,
      volume: 0,
    });
    assert.equal(filled[0]?.volume, 10);
    assert.equal(filled[2]?.close, 2);
  });

  it("does not invent bars before the first trade and extends a quiet tail", () => {
    const filled = fillCandleGaps(
      [{ time: 300, open: 2, high: 2, low: 2, close: 2, volume: 1 }],
      300,
      900,
      10,
    );
    assert.equal(filled[0]?.time, 300);
    assert.deepEqual(
      filled.map((candle) => candle.time),
      [300, 600, 900],
    );
    assert.equal(filled[2]?.close, 2);
    assert.equal(filled[2]?.volume, 0);
  });

  it("keeps the most recent bars when the span exceeds maxBars", () => {
    const filled = fillCandleGaps(
      [
        { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { time: 900, open: 4, high: 4, low: 4, close: 4, volume: 2 },
      ],
      300,
      900,
      3,
    );
    assert.deepEqual(
      filled.map((candle) => [candle.time, candle.close, candle.volume]),
      [
        [300, 1, 0],
        [600, 1, 0],
        [900, 4, 2],
      ],
    );
  });

  it("gives ATR a closed bar for every slot in the period after a hole", () => {
    const filled = fillCandleGaps(
      [
        { time: 0, open: 10, high: 11, low: 9, close: 10, volume: 1 },
        { time: 600, open: 10, high: 12, low: 10, close: 11, volume: 1 },
      ],
      300,
      600,
      10,
    );
    assert.equal(filled.length, 3);
    const { latest } = computeSupertrend(filled, 3, 3);
    assert.ok(latest);
    assert.equal(latest.index, 2);
  });
});

describe("meteora timeframe", () => {
  it("maps the shared intervals and rejects GMGN-only ones", () => {
    assert.equal(meteoraTimeframe("5m"), "5m");
    assert.equal(meteoraTimeframe("1d"), "24h");
    assert.equal(meteoraTimeframe("1m"), undefined);
    assert.equal(meteoraTimeframe("15m"), undefined);
  });

  it("names the previous bar when now sits on a boundary", () => {
    assert.equal(lastClosedOpenSec(1_000, 300), 600);
    assert.equal(lastClosedOpenSec(900, 300), 600);
  });
});
