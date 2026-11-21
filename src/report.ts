import { config } from "./config.js";
import { escapeHtml, formatUsd } from "./format.js";
import type { AlertPayload } from "./telegram.js";

export interface InlineButton {
  text: string;
  url?: string;
  copy_text?: { text: string };
}

export interface ReportPart {
  text: string;
  keyboard: { inline_keyboard: InlineButton[][] };
  tokens: number;
}

const BUTTONS_PER_ROW = 3;

function clock(): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.report.timezone,
  }).format(new Date());
}

function renderLine(payload: AlertPayload, index: number): string {
  const symbol = escapeHtml(payload.symbol || "?");
  const parts = [
    `${index}. <b>$${symbol}</b>`,
    `MC ${formatUsd(payload.marketCap)}`,
    `vol ${formatUsd(payload.vol5mUsd)}`,
  ];
  if (payload.ath) parts.push("🔥ATH");
  return parts.join(" · ");
}

/** One copy-CA button per token, with a mint suffix when symbols collide. */
function tokenKeyboard(payloads: AlertPayload[]): { inline_keyboard: InlineButton[][] } {
  const totals = new Map<string, number>();
  for (const payload of payloads) {
    totals.set(payload.symbol, (totals.get(payload.symbol) ?? 0) + 1);
  }

  const buttons: InlineButton[] = payloads.map((payload) => {
    const duplicated = (totals.get(payload.symbol) ?? 0) > 1;
    const label = duplicated
      ? `📋 $${payload.symbol} ·${payload.mint.slice(0, 4)}`
      : `📋 $${payload.symbol}`;
    return { text: label, copy_text: { text: payload.mint } };
  });

  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
  }

  return { inline_keyboard: rows };
}

/**
 * Builds the every-N-minutes watchlist: tokens that pass every hard filter
 * except the 5m volume threshold. Ordered by 5m volume, capped by the caller.
 */
export function buildWatchlist(payloads: AlertPayload[], dropped = 0): ReportPart {
  const sorted = [...payloads].sort((a, b) => b.vol5mUsd - a.vol5mUsd);
  const threshold =
    config.scan.minVol5mUsd > 0
      ? `<i>semua filter lolos · vol 5m &lt; ${formatUsd(config.scan.minVol5mUsd)}</i>`
      : "";

  const blocks = [
    `👀 <b>Watchlist</b> · ${sorted.length} token · ${clock()} ${config.report.tzLabel}`,
  ];
  if (threshold) blocks.push(threshold);
  blocks.push("");
  blocks.push(...sorted.map((payload, index) => renderLine(payload, index + 1)));

  if (dropped > 0) {
    blocks.push("");
    blocks.push(`<i>+${dropped} lainnya (tercatat di log)</i>`);
  }

  return { text: blocks.join("\n"), keyboard: tokenKeyboard(sorted), tokens: sorted.length };
}
