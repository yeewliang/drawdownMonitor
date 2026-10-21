import { defineSecret, defineString } from "firebase-functions/params";

export const APP_URL = defineString("APP_URL", { default: "http://localhost:5173" });

// Telegram
export const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
/** Random string passed to setWebhook as secret_token; verified on every update. */
export const TELEGRAM_WEBHOOK_SECRET = defineSecret("TELEGRAM_WEBHOOK_SECRET");

// Email (any SMTP provider: SendGrid, Resend, Mailgun, SES, Gmail app password...)
export const SMTP_HOST = defineString("SMTP_HOST", { default: "" });
export const SMTP_PORT = defineString("SMTP_PORT", { default: "587" });
export const SMTP_USER = defineString("SMTP_USER", { default: "" });
export const SMTP_PASS = defineSecret("SMTP_PASS");
export const MAIL_FROM = defineString("MAIL_FROM", { default: "Drawdown Monitor <alerts@example.com>" });

export const REGION = "us-central1";

/** Secrets needed by any function that sends notifications. */
export const NOTIFY_SECRETS = [TELEGRAM_BOT_TOKEN, SMTP_PASS];
