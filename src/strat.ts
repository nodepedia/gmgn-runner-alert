import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { pacer } from "./gmgn.js";
import { log } from "./logger.js";

type Value = string | number | boolean | string[];

export interface FieldSpec {
  key: string;
  group: "gmgn" | "telegram" | "filter" | "runtime" | "cache" | "report";
  label: string;
  secret?: boolean;
  /** Applied in memory but only takes effect after a restart. */
  restartOnly?: boolean;
  read: () => Value;
  parse: (raw: string) => Value;
  write: (value: Value) => void;
}

interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  restartOnly?: boolean;
}

function numberField(
  key: string,
  group: FieldSpec["group"],
  label: string,
  read: () => number,
  write: (value: number) => void,
  options: NumberOptions = {},
): FieldSpec {
  return {
    key,
    group,
    label,
    restartOnly: options.restartOnly,
    read,
    write: (value) => write(value as number),
    parse: (raw) => {
      const trimmed = raw.trim();
      if (trimmed === "") throw new Error("value is empty");
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error(`"${raw}" is not a number`);
      if (options.integer && !Number.isInteger(parsed)) {
        throw new Error(`"${raw}" must be a whole number`);
      }
      if (options.min !== undefined && parsed < options.min) {
        throw new Error(`${parsed} is below the minimum ${options.min}`);
      }
      if (options.max !== undefined && parsed > options.max) {
        throw new Error(`${parsed} is above the maximum ${options.max}`);
      }
      return parsed;
    },
  };
}

function boolField(
  key: string,
  group: FieldSpec["group"],
  label: string,
  read: () => boolean,
  write: (value: boolean) => void,
): FieldSpec {
  return {
    key,
    group,
    label,
    read,
    write: (value) => write(value as boolean),
    parse: (raw) => {
      const value = raw.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(value)) return true;
      if (["0", "false", "no", "off"].includes(value)) return false;
      throw new Error(`"${raw}" is not a boolean (use true/false)`);
    },
  };
}

function textField(
  key: string,
  group: FieldSpec["group"],
  label: string,
  read: () => string,
  write: (value: string) => void,
  options: { secret?: boolean; restartOnly?: boolean; maxLength?: number; pattern?: RegExp } = {},
): FieldSpec {
  return {
    key,
    group,
    label,
    secret: options.secret,
    restartOnly: options.restartOnly,
    read,
    write: (value) => write(value as string),
    parse: (raw) => {
      const value = raw.trim();
      if (value === "") throw new Error("value is empty");
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        throw new Error(`longer than ${options.maxLength} characters`);
      }
      if (options.pattern && !options.pattern.test(value)) {
        throw new Error(`"${value}" has an invalid format`);
      }
      return value;
    },
  };
}

function listField(
  key: string,
  group: FieldSpec["group"],
  label: string,
  read: () => string[],
  write: (value: string[]) => void,
  options: { secret?: boolean; pattern?: RegExp } = {},
): FieldSpec {
  return {
    key,
    group,
    label,
    secret: options.secret,
    read: () => [...read()],
    write: (value) => write(value as string[]),
    parse: (raw) => {
      const values = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (values.length === 0) throw new Error("no chat id given");
      if (options.pattern) {
        const bad = values.find((item) => !options.pattern!.test(item));
        if (bad) throw new Error(`"${bad}" has an invalid format`);
      }
      return values;
    },
  };
}

const TRENDING_INTERVALS = ["1m", "5m", "1h", "6h", "24h"];
const TRENDING_INTERVAL_PATTERN = new RegExp(`^(${TRENDING_INTERVALS.join("|")})$`);

export const FIELDS: FieldSpec[] = [
  // --- GMGN / pacing -------------------------------------------------------
  textField(
    "GMGN_BASE_URL",
    "gmgn",
    "API base URL",
    () => config.gmgn.baseUrl,
    (value) => {
      config.gmgn.baseUrl = value;
    },
    { pattern: /^https?:\/\// },
  ),
  textField(
    "GMGN_API_KEY",
    "gmgn",
    "API key (secret)",
    () => config.gmgn.apiKey,
    (value) => {
      config.gmgn.apiKey = value;
    },
    { secret: true },
  ),
  numberField(
    "GMGN_MIN_GAP_MS",
    "gmgn",
    "gap between requests",
    () => config.gmgn.minGapMs,
    (value) => {
      config.gmgn.minGapMs = value;
    },
    { integer: true, min: 250, max: 60_000 },
  ),
  numberField(
    "GMGN_MAX_GAP_MS",
    "gmgn",
    "max gap after a 429",
    () => config.gmgn.maxGapMs,
    (value) => {
      config.gmgn.maxGapMs = value;
    },
    { integer: true, min: 500, max: 120_000 },
  ),
  numberField(
    "GMGN_RANK_SETTLE_MS",
    "gmgn",
    "pause after market/rank",
    () => config.gmgn.rankSettleMs,
    (value) => {
      config.gmgn.rankSettleMs = value;
    },
    { integer: true, min: 0, max: 30_000 },
  ),

  // --- Telegram ------------------------------------------------------------
  textField(
    "TELEGRAM_BOT_TOKEN",
    "telegram",
    "bot token (secret)",
    () => config.telegram.token,
    (value) => {
      config.telegram.token = value;
    },
    { secret: true },
  ),
  listField(
    "TELEGRAM_CHAT_ID",
    "telegram",
    "chat ids, comma separated",
    () => config.telegram.chatIds,
    (value) => {
      config.telegram.chatIds = value;
    },
    { secret: true, pattern: /^-?\d+$/ },
  ),

  // --- Trending source -----------------------------------------------------
  textField(
    "TRENDING_INTERVAL",
    "filter",
    "GMGN interval (1m/5m/1h/6h/24h)",
    () => config.scan.interval,
    (value) => {
      config.scan.interval = value;
    },
    { pattern: TRENDING_INTERVAL_PATTERN, maxLength: 4 },
  ),
  numberField(
    "TRENDING_LIMIT",
    "filter",
    "trending rows fetched",
    () => config.scan.limit,
    (value) => {
      config.scan.limit = value;
    },
    { integer: true, min: 1, max: 100 },
  ),
  textField(
    "TRENDING_ORDER_BY",
    "filter",
    "sort field",
    () => config.scan.orderBy,
    (value) => {
      config.scan.orderBy = value;
    },
    { pattern: /^[a-z_]+$/, maxLength: 32 },
  ),

  // --- Filters -------------------------------------------------------------
  numberField(
    "MIN_AGE_HOURS",
    "filter",
    "minimum token age",
    () => config.scan.minAgeHours,
    (value) => {
      config.scan.minAgeHours = value;
    },
    { min: 0, max: 8_760 },
  ),
  numberField(
    "MIN_MARKET_CAP",
    "filter",
    "minimum market cap (USD)",
    () => config.scan.minMarketCap,
    (value) => {
      config.scan.minMarketCap = value;
    },
    { min: 0, max: 1e12 },
  ),
  numberField(
    "MIN_TOTAL_FEE_SOL",
    "filter",
    "minimum total fees (SOL)",
    () => config.scan.minTotalFeeSol,
    (value) => {
      config.scan.minTotalFeeSol = value;
    },
    { min: 0, max: 1e7 },
  ),
  numberField(
    "MIN_VOL5M_USD",
    "filter",
    "minimum 5m volume (USD, 0=off)",
    () => config.scan.minVol5mUsd,
    (value) => {
      config.scan.minVol5mUsd = value;
    },
    { min: 0, max: 1e12 },
  ),
  numberField(
    "MIN_TVL_USD",
    "filter",
    "minimum Meteora TVL (USD, 0=off)",
    () => config.scan.minTvlUsd,
    (value) => {
      config.scan.minTvlUsd = value;
    },
    { min: 0, max: 1e12 },
  ),
  numberField(
    "ATH_TOLERANCE",
    "filter",
    "ATH ratio (0.995 = within 0.5%)",
    () => config.scan.athTolerance,
    (value) => {
      config.scan.athTolerance = value;
    },
    { min: 0.5, max: 1 },
  ),

  // --- Cycle ---------------------------------------------------------------
  numberField(
    "POLL_INTERVAL_MS",
    "runtime",
    "delay between cycles",
    () => config.scan.pollMs,
    (value) => {
      config.scan.pollMs = value;
    },
    { integer: true, min: 10_000, max: 3_600_000 },
  ),
  numberField(
    "MAX_CANDIDATES_PER_CYCLE",
    "runtime",
    "max tokens checked per cycle",
    () => config.scan.maxCandidatesPerCycle,
    (value) => {
      config.scan.maxCandidatesPerCycle = value;
    },
    { integer: true, min: 1, max: 100 },
  ),
  numberField(
    "COOLDOWN_MINUTES",
    "runtime",
    "per-token alert cooldown",
    () => config.scan.cooldownMinutes,
    (value) => {
      config.scan.cooldownMinutes = value;
      config.scan.cooldownMs = value * 60_000;
    },
    { min: 0, max: 10_080 },
  ),
  boolField(
    "DRY_RUN",
    "runtime",
    "log alerts instead of sending",
    () => config.dryRun,
    (value) => {
      config.dryRun = value;
    },
  ),
  textField(
    "DB_PATH",
    "runtime",
    "SQLite file (restart only)",
    () => config.dbPath,
    (value) => {
      config.dbPath = value;
    },
    { restartOnly: true, maxLength: 512 },
  ),

  // --- Cache ---------------------------------------------------------------
  numberField(
    "INFO_CACHE_MS",
    "cache",
    "token/info cache TTL",
    () => config.scan.infoCacheMs,
    (value) => {
      config.scan.infoCacheMs = value;
    },
    { integer: true, min: 5_000, max: 3_600_000 },
  ),
  numberField(
    "SECURITY_CACHE_MS",
    "cache",
    "token/security cache TTL",
    () => config.scan.securityCacheMs,
    (value) => {
      config.scan.securityCacheMs = value;
    },
    { integer: true, min: 60_000, max: 86_400_000 },
  ),
  numberField(
    "METEORA_CACHE_MS",
    "cache",
    "Meteora TVL cache TTL",
    () => config.scan.meteoraCacheMs,
    (value) => {
      config.scan.meteoraCacheMs = value;
    },
    { integer: true, min: 30_000, max: 3_600_000 },
  ),

  // --- Report --------------------------------------------------------------
  textField(
    "REPORT_MODE",
    "report",
    "digest or individual",
    () => config.report.mode,
    (value) => {
      config.report.mode = value as typeof config.report.mode;
    },
    { pattern: /^(digest|individual)$/ },
  ),
  numberField(
    "REPORT_WINDOW_MINUTES",
    "report",
    "watchlist digest cadence",
    () => config.report.windowMinutes,
    (value) => {
      config.report.windowMinutes = value;
    },
    { min: 0, max: 60 },
  ),
  numberField(
    "WATCHLIST_MAX",
    "report",
    "max tokens per watchlist",
    () => config.report.watchlistMax,
    (value) => {
      config.report.watchlistMax = value;
    },
    { integer: true, min: 1, max: 100 },
  ),
  textField(
    "REPORT_TIMEZONE",
    "report",
    "IANA timezone",
    () => config.report.timezone,
    (value) => {
      config.report.timezone = value;
    },
    { maxLength: 64 },
  ),
  textField(
    "REPORT_TZ_LABEL",
    "report",
    "label after the clock",
    () => config.report.tzLabel,
    (value) => {
      config.report.tzLabel = value;
    },
    { maxLength: 8 },
  ),
];

const fieldByKey = new Map(FIELDS.map((field) => [field.key, field]));

/** Keys that currently come from strat.conf rather than .env/defaults. */
const fromStratFile = new Set<string>();

export interface StratChange {
  key: string;
  from: Value;
  to: Value;
}

export interface StratResult {
  file: string;
  parsed: number;
  changes: StratChange[];
  unknown: string[];
  errors: string[];
}

function equal(a: Value, b: Value): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatValue(field: FieldSpec, value: Value): string {
  if (field.secret) return "***";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

export function parseStrat(text: string): {
  entries: Array<[string, string]>;
  errors: string[];
} {
  const entries: Array<[string, string]> = [];
  const errors: string[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) return;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`line ${index + 1}: expected KEY=value, got "${line.slice(0, 60)}"`);
      return;
    }

    let value = match[2].trim();
    // Allow a trailing comment only when separated by whitespace, so values
    // like a token that contains "#" are not cut in half.
    const hash = value.search(/\s[#;]/);
    if (hash >= 0) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.push([match[1], value]);
  });

  return { entries, errors };
}

export function applyStratText(text: string, file = "strat.conf"): StratResult {
  const { entries, errors } = parseStrat(text);
  const staged = new Map<FieldSpec, Value>();
  const unknown: string[] = [];

  for (const [key, raw] of entries) {
    const field = fieldByKey.get(key);
    if (!field) {
      if (!unknown.includes(key)) unknown.push(key);
      continue;
    }
    try {
      staged.set(field, field.parse(raw));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${key}: ${reason}`);
    }
  }

  // Cross-field sanity: the adaptive gap must be able to grow to maxGapMs.
  const gapField = fieldByKey.get("GMGN_MIN_GAP_MS");
  const maxGapField = fieldByKey.get("GMGN_MAX_GAP_MS");
  if (gapField && maxGapField) {
    const minGap = staged.get(gapField) ?? config.gmgn.minGapMs;
    const maxGap = staged.get(maxGapField) ?? config.gmgn.maxGapMs;
    if (typeof minGap === "number" && typeof maxGap === "number" && minGap > maxGap) {
      errors.push(`GMGN_MIN_GAP_MS (${minGap}) must be <= GMGN_MAX_GAP_MS (${maxGap})`);
      staged.delete(gapField);
      staged.delete(maxGapField);
    }
  }

  const changes: StratChange[] = [];

  for (const [field, value] of staged) {
    const before = field.read();
    fromStratFile.add(field.key);
    if (equal(before, value)) continue;
    field.write(value);
    changes.push({ key: field.key, from: before, to: value });
    if (field.restartOnly) {
      log.warn(`${field.key} changed but only applies after a restart`);
    }
  }

  if (
    changes.some((change) => change.key === "GMGN_MIN_GAP_MS" || change.key === "GMGN_MAX_GAP_MS")
  ) {
    pacer.reconfigure({
      minGapMs: config.gmgn.minGapMs,
      maxGapMs: config.gmgn.maxGapMs,
    });
  }

  return {
    file,
    parsed: entries.length,
    changes,
    unknown,
    errors,
  };
}

export function applyStratFile(file: string): StratResult {
  const text = readFileSync(file, "utf8");
  return applyStratText(text, file);
}

function reportResult(result: StratResult, appliedMessage: string): void {
  for (const error of result.errors) {
    log.error(`strat.conf ignored a value -> ${error}`);
  }

  if (result.unknown.length > 0) {
    log.warn(
      `strat.conf has ${result.unknown.length} unknown key(s), ignored: ${result.unknown.join(", ")}`,
    );
    log.warn(`valid keys: ${FIELDS.map((field) => field.key).join(", ")}`);
  }

  if (result.changes.length === 0) {
    log.info(appliedMessage, {
      file: result.file,
      keys: result.parsed,
      changed: 0,
      errors: result.errors.length,
    });
    return;
  }

  log.info(appliedMessage, {
    file: result.file,
    keys: result.parsed,
    changed: result.changes.length,
    errors: result.errors.length,
  });

  for (const change of result.changes) {
    const field = fieldByKey.get(change.key)!;
    log.info(`strat ${change.key}: ${formatValue(field, change.from)} -> ${formatValue(field, change.to)}`);
  }
}

let stratFile: string | null = null;
let stratMtime = 0;

export function stratPath(): string {
  return resolve(process.env.STRAT_FILE?.trim() || "strat.conf");
}

/** Loads strat.conf at startup. Missing file is not an error. */
export function initStrat(): StratResult | null {
  const file = stratPath();
  stratFile = file;

  try {
    stratMtime = statSync(file).mtimeMs;
  } catch {
    log.info(`strat.conf not found at ${file}, using .env / built-in defaults`);
    return null;
  }

  const result = applyStratFile(file);
  reportResult(result, "strat.conf loaded");
  return result;
}

/**
 * Cheap mtime check, called once per cycle. Editing strat.conf is enough to
 * change filters, cooldown, pacing, poll interval and report layout.
 */
export function reloadStratIfChanged(): StratResult | null {
  if (!stratFile) return null;

  let mtime: number;
  try {
    mtime = statSync(stratFile).mtimeMs;
  } catch {
    return null;
  }
  if (mtime === stratMtime) return null;

  stratMtime = mtime;
  const result = applyStratFile(stratFile);
  reportResult(result, "strat.conf reloaded");
  return result;
}

export function printEffectiveConfig(): void {
  const rows = FIELDS.map((field) => {
    const source = fromStratFile.has(field.key)
      ? "strat.conf"
      : process.env[field.key] !== undefined && process.env[field.key] !== ""
        ? ".env"
        : "default";
    return {
      group: field.group,
      key: field.key,
      value: formatValue(field, field.read()),
      hint: field.restartOnly ? "restart" : "",
      source,
    };
  });

  const keyWidth = Math.max(...rows.map((row) => row.key.length));
  const valueWidth = Math.min(44, Math.max(...rows.map((row) => row.value.length)));
  let group = "";

  for (const row of rows) {
    if (row.group !== group) {
      group = row.group;
      console.log(`\n[${group}]`);
    }
    console.log(
      `  ${row.key.padEnd(keyWidth)}  ${row.value.padEnd(valueWidth)}  ${row.source}${row.hint ? " *" + row.hint : ""}`,
    );
  }

  console.log(`\nfile: ${stratPath()}`);
  console.log("edit the file, then wait for the next cycle (no restart needed)");
}
