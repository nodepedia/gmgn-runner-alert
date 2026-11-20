import { config } from "./config.js";
import { log } from "./logger.js";

export interface AlertPayload {
  mint: string;
  symbol: string;
  name?: string;
  marketCap: number;
  ageSeconds: number;
  totalFeeSol: number;
  vol5mUsd: number;
  tvlUsd: number;
  poolCount: number;
  ath?: {
    isNew: boolean;
    historyMarketCap: number;
    previousMarketCap: number;
  };
}

interface InlineButton {
  text: string;
  url?: string;
  copy_text?: { text: string };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatAge(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatSol(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} SOL`;
}

export function buildMessage(payload: AlertPayload): string {
  const symbol = escapeHtml(payload.symbol || "?");
  const lines: string[] = [];

  lines.push(`🚀 <b>$${symbol}</b> — Runner Alert`);

  if (payload.name && payload.name.trim().toLowerCase() !== payload.symbol.trim().toLowerCase()) {
    lines.push(`<i>${escapeHtml(payload.name)}</i>`);
  }

  lines.push("");
  lines.push(
    `MCAP <b>${formatUsd(payload.marketCap)}</b> · Age <b>${formatAge(payload.ageSeconds)}</b> · Fees <b>${formatSol(payload.totalFeeSol)}</b>`,
  );
  lines.push(
    `Vol 5m <b>${formatUsd(payload.vol5mUsd)}</b> · Meteora TVL <b>${formatUsd(payload.tvlUsd)}</b> (${payload.poolCount} pool)`,
  );

  if (payload.ath) {
    const previous =
      payload.ath.previousMarketCap > 0
        ? ` (prev ${formatUsd(payload.ath.previousMarketCap)})`
        : "";
    const label = payload.ath.isNew ? "🔥 <b>NEW ATH</b>" : "📈 <b>AT ATH</b>";
    lines.push(`${label} — MCAP ${formatUsd(payload.ath.historyMarketCap)}${previous}`);
  }

  lines.push("");
  lines.push(`<b>CA:</b> <code>${payload.mint}</code>`);

  return lines.join("\n");
}

function buildKeyboard(mint: string): { inline_keyboard: InlineButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: "📋 Copy CA", copy_text: { text: mint } },
        { text: "GMGN", url: `https://gmgn.ai/sol/token/${mint}` },
      ],
      [
        { text: "Dexscreener", url: `https://dexscreener.com/solana/${mint}` },
        { text: "Solscan", url: `https://solscan.io/token/${mint}` },
      ],
    ],
  };
}

async function callTelegram(
  method: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

async function broadcast(
  text: string,
  keyboard?: { inline_keyboard: InlineButton[][] },
): Promise<void> {
  if (!config.telegram.token || config.telegram.chatIds.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not configured");
  }

  for (const chatId of config.telegram.chatIds) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (keyboard) payload.reply_markup = keyboard;

    let response = await callTelegram("sendMessage", payload);

    // Older Bot API versions reject copy_text buttons. Retry without them.
    if (!response.ok && keyboard) {
      const errorText = await response.text();
      if (errorText.includes("copy_text") || errorText.includes("reply_markup")) {
        log.warn("copy_text button rejected, retrying without it", errorText.slice(0, 200));
        const fallback = {
          inline_keyboard: keyboard.inline_keyboard.map((row) =>
            row.filter((button) => !button.copy_text),
          ),
        };
        response = await callTelegram("sendMessage", { ...payload, reply_markup: fallback });
      } else {
        throw new Error(`Telegram HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram HTTP ${response.status}: ${errorText.slice(0, 300)}`);
    }
  }
}

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const text = buildMessage(payload);
  await broadcast(text, buildKeyboard(payload.mint));
  log.info(`alert sent $${payload.symbol}`, { mint: payload.mint });
}

export async function sendTestMessage(): Promise<void> {
  const text = [
    "✅ <b>gmgn-runner-alert aktif</b>",
    "",
    `Trending: <b>${config.scan.interval}</b> · limit ${config.scan.limit}`,
    `Filter: age ≥ ${config.scan.minAgeHours}h · MCAP ≥ ${formatUsd(config.scan.minMarketCap)} · fees ≥ ${config.scan.minTotalFeeSol} SOL`,
    `Cooldown: ${config.scan.cooldownMs / 60_000} menit`,
    "",
    "Bot siap memantau.",
  ].join("\n");

  await broadcast(text);
  log.info("test message sent");
}
