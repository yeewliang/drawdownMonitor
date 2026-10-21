import { escapeHtml } from "./telegram";

export interface AlertItem {
  symbol: string;
  name: string;
  watchlistId: string;
  watchlistName: string;
  threshold: number;
  drawdownPct: number;
  price: number;
  currency: string;
  ath: number;
  athDate: Date | null;
  basis: "close" | "intraday";
}

export interface FormattedAlert {
  subject: string;
  text: string;
  html: string;
  telegram: string;
}

const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 });
const fmtPct = (n: number) => `${n.toFixed(2)}%`;
const fmtDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "n/a");

export function formatAlerts(alerts: AlertItem[], appUrl: string): FormattedAlert {
  const subject =
    alerts.length === 1
      ? `${alerts[0].symbol} is ${fmtPct(alerts[0].drawdownPct)} below its all-time high`
      : `${alerts.length} drawdown alerts: ${alerts.map((a) => a.symbol).join(", ")}`;

  const line = (a: AlertItem) =>
    `${a.symbol} (${a.name}) crossed -${a.threshold}%: now ${fmtNum(a.price)} ${a.currency}, ` +
    `${fmtPct(a.drawdownPct)} below ATH ${fmtNum(a.ath)} (${a.basis}, ${fmtDate(a.athDate)}) [${a.watchlistName}]`;

  const text = `${alerts.map(line).join("\n")}\n\nOpen Drawdown Monitor: ${appUrl}\n`;

  const rows = alerts
    .map(
      (a) => `<tr>
  <td style="padding:6px 10px"><a href="${appUrl}/w/${encodeURIComponent(a.watchlistId)}"><b>${escapeHtml(a.symbol)}</b></a><br><small>${escapeHtml(a.name)}</small></td>
  <td style="padding:6px 10px;color:#c0392b"><b>-${fmtPct(a.drawdownPct)}</b><br><small>threshold -${a.threshold}%</small></td>
  <td style="padding:6px 10px">${fmtNum(a.price)} ${escapeHtml(a.currency)}</td>
  <td style="padding:6px 10px">${fmtNum(a.ath)}<br><small>${a.basis} ATH, ${fmtDate(a.athDate)}</small></td>
  <td style="padding:6px 10px">${escapeHtml(a.watchlistName)}</td>
</tr>`,
    )
    .join("\n");
  const html = `<div style="font-family:system-ui,sans-serif">
<h2 style="margin:0 0 12px">Drawdown alert</h2>
<table style="border-collapse:collapse" border="1" cellspacing="0">
<tr><th>Symbol</th><th>Drawdown</th><th>Price</th><th>ATH</th><th>Watchlist</th></tr>
${rows}
</table>
<p><a href="${appUrl}">Open Drawdown Monitor</a></p>
</div>`;

  const telegram =
    `<b>📉 Drawdown alert</b>\n\n` +
    alerts
      .map(
        (a) =>
          `<b>${escapeHtml(a.symbol)}</b> ${escapeHtml(a.name)}\n` +
          `-${fmtPct(a.drawdownPct)} from ATH (crossed -${a.threshold}%)\n` +
          `Price ${fmtNum(a.price)} ${escapeHtml(a.currency)} | ATH ${fmtNum(a.ath)} on ${fmtDate(a.athDate)}\n` +
          `<i>${escapeHtml(a.watchlistName)}</i>`,
      )
      .join("\n\n") +
    `\n\n<a href="${appUrl}">Open Drawdown Monitor</a>`;

  return { subject, text, html, telegram };
}
