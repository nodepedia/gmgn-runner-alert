import { config } from "./config.js";
import { log } from "./logger.js";
import { escapeHtml, formatUsd } from "./format.js";
import { buildReport, type InlineButton } from "./report.js";

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

type Keyboard = { inline_keyboard: InlineButton[][] };

export function buildMessage(payload: AlertPayload): string {
  const symbol = escapeHtml(payload.symbol || "?");
  const lines: string[] = [`🚀 <b>$${symbol}</b> — Runner Alert`];

  if (
    payload.name &&
    payload.name.trim().toLowerCase() !== payload.symbol.trim().toLowerCase()
  ) {
    lines.push(`<i>${escapeHtml(payload.name)}</i>`);
  }

  const stats = [
    `MC <b>${formatUsd(payload.marketCap)}</b>`,
    `Vol 5m <b>${formatUsd(payload.vol5mUsd)}</b>`,
  ];
  if (payload.ath) stats.push("🔥<b>ATH</b>");

  lines.push("");
  lines.push(stats.join(" · "));
  lines.push("");
  lines.push(`<b>CA:</b> <code>${payload.mint}</code>`);

  return lines.join("\n");
}

function buildKeyboard(mint: string): Keyboard {
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

async function send(chatId: string, text: string, keyboard?: Keyboard): Promise<void> {
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
      const fallback: Keyboard = {
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

async function broadcast(text: string, keyboard?: Keyboard): Promise<void> {
  if (!config.telegram.token || config.telegram.chatIds.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not configured");
  }
  for (const chatId of config.telegram.chatIds) {
    await send(chatId, text, keyboard);
  }
}

export async function sendAlert(payload: AlertPayload): Promise<void> {
  await broadcast(buildMessage(payload), buildKeyboard(payload.mint));
  log.info(`alert sent $${payload.symbol}`, { mint: payload.mint });
}

/**
 * Sends one message per chunk of tokens. If Telegram rejects one chunk, the
 * error propagates and the caller must not record those tokens as alerted.
 */
export async function sendReport(payloads: AlertPayload[]): Promise<number> {
  const parts = buildReport(payloads);

  for (const [index, part] of parts.entries()) {
    await broadcast(part.text, part.keyboard);
    if (parts.length > 1) {
      log.info(`report part ${index + 1}/${parts.length} sent`, { tokens: part.tokens });
    }
  }

  log.info("report sent", { tokens: payloads.length, parts: parts.length });
  return parts.length;
}

export async function sendTestMessage(): Promise<void> {
  const text = [
    "✅ <b>gmgn-runner-alert aktif</b>",
    "",
    `Report: <b>${config.report.mode}</b> · trending <b>${config.scan.interval}</b> · limit ${config.scan.limit}`,
    `Filter: age ≥ ${config.scan.minAgeHours}h · MC ≥ ${formatUsd(config.scan.minMarketCap)} · fees ≥ ${config.scan.minTotalFeeSol} SOL`,
    `Cooldown: ${config.scan.cooldownMs / 60_000} menit`,
    "",
    "Bot siap memantau.",
  ].join("\n");

  await broadcast(text);
  log.info("test message sent");
}
