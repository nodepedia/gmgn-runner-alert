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
const HEADER_BUDGET = 80;

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

function buildKeyboard(payloads: AlertPayload[]): { inline_keyboard: InlineButton[][] } {
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
  rows.push([{ text: "🔗 GMGN Trending", url: "https://gmgn.ai/?chain=sol" }]);

  return { inline_keyboard: rows };
}

/**
 * Builds one digest message per chunk of tokens. Tokens are ordered by market
 * cap (largest first) and numbering stays continuous across chunks.
 */
export function buildReport(payloads: AlertPayload[]): ReportPart[] {
  const sorted = [...payloads].sort((a, b) => b.marketCap - a.marketCap);
  const chunks: { lines: string[]; items: AlertPayload[] }[] = [];

  let current: { lines: string[]; items: AlertPayload[] } = { lines: [], items: [] };
  let size = 0;
  let index = 0;

  for (const payload of sorted) {
    index += 1;
    const line = renderLine(payload, index);
    const tooMany = current.items.length >= config.report.maxTokensPerMessage;
    const tooLong =
      current.items.length > 0 &&
      size + line.length + 1 > config.report.maxChars - HEADER_BUDGET;

    if (tooMany || tooLong) {
      chunks.push(current);
      current = { lines: [], items: [] };
      size = 0;
    }

    current.lines.push(line);
    current.items.push(payload);
    size += line.length + 1;
  }

  if (current.items.length > 0) chunks.push(current);

  const total = sorted.length;
  const time = clock();

  return chunks.map((chunk, chunkIndex) => {
    const partLabel = chunks.length > 1 ? ` · ${chunkIndex + 1}/${chunks.length}` : "";
    const header = `🚀 <b>Runner Alert</b> · ${total} token · ${time} ${config.report.tzLabel}${partLabel}`;
    return {
      text: [header, "", ...chunk.lines].join("\n"),
      keyboard: buildKeyboard(chunk.items),
      tokens: chunk.items.length,
    };
  });
}
