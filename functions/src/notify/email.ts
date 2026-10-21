import nodemailer, { Transporter } from "nodemailer";
import { MAIL_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER } from "../config";

let transporter: Transporter | null = null;

export function emailConfigured(): boolean {
  return !!SMTP_HOST.value();
}

export async function sendEmail(to: string, subject: string, text: string, html: string): Promise<void> {
  if (!emailConfigured()) throw new Error("SMTP_HOST is not configured");
  if (!transporter) {
    const port = Number(SMTP_PORT.value()) || 587;
    transporter = nodemailer.createTransport({
      host: SMTP_HOST.value(),
      port,
      secure: port === 465,
      auth: SMTP_USER.value() ? { user: SMTP_USER.value(), pass: SMTP_PASS.value() } : undefined,
    });
  }
  await transporter.sendMail({ from: MAIL_FROM.value(), to, subject, text, html });
}
