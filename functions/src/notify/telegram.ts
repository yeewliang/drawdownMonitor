import { TELEGRAM_BOT_TOKEN } from "../config";

export class TelegramError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** Send an HTML-formatted message via the Bot API. */
export async function sendTelegram(chatId: number, html: string): Promise<void> {
  const token = TELEGRAM_BOT_TOKEN.value();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new TelegramError(`Telegram ${res.status}: ${body?.description ?? res.statusText}`, res.status);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
