import { doc } from "firebase/firestore";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import ReturnChart from "../components/ReturnChart";
import ThresholdEditor from "../components/ThresholdEditor";
import { useDocData, useQuotes } from "../hooks/firestore";
import { updatePortfolioAlerts } from "../lib/api";
import { db } from "../lib/firebase";
import { athOf, drawdownOf, fmtAgo, fmtDate, fmtPct, severity } from "../lib/format";
import { fmtDay, fmtMoney, fmtQty, rangeSeries, viewPortfolio, type Range } from "../lib/portfolio";
import type { AthBasis, Portfolio, Quote } from "../lib/types";

const RANGES: Range[] = ["1M", "3M", "YTD", "1Y", "ALL"];

export default function PortfolioPage() {
  const { user, profile } = useAuth();
  const pf = useDocData<Portfolio>(user ? doc(db, "portfolios", user.uid) : null, `pf:${user?.uid}`);
  const symbols = useMemo(() => pf.data?.positions.map((p) => p.symbol) ?? [], [pf.data]);
  const quotes = useQuotes(symbols);
  const basis: AthBasis = profile?.athBasis ?? "close";

  if (pf.loading) return <p className="muted">Loading…</p>;
  if (pf.error) return <p className="error-text">Could not load your portfolio: {pf.error.message}</p>;
  if (!pf.data) return <EmptyState />;
  return (
    <PortfolioContent
      p={pf.data}
      quotes={quotes}
      basis={basis}
      onAlerts={(data) => updatePortfolioAlerts(user!.uid, data)}
    />
  );
}

/** The page body, separate from data loading so it can be previewed with sample data. */
export function PortfolioContent({ p, quotes, basis, onAlerts }: {
  p: Portfolio;
  quotes: Record<string, Quote>;
  basis: AthBasis;
  onAlerts: (data: { thresholds?: number[]; alertsEnabled?: boolean }) => Promise<void>;
}) {
  const [range, setRange] = useState<Range>("YTD");
  const cur = p.baseCurrency || "USD";
  const v = viewPortfolio(p, quotes);
  const series = rangeSeries(p, range);
  const rangeRet = series.length > 1 ? series[series.length - 1].ret : null;
  const tone = (n: number | null | undefined) => (n == null ? "" : n > 0 ? "up" : n < 0 ? "down" : "");
  const unrPct = v.costBasis ? (v.unrealizedPnl / v.costBasis) * 100 : null;
  const dayPct = v.dayPnl != null && v.value - v.dayPnl > 0 ? (v.dayPnl / (v.value - v.dayPnl)) * 100 : null;
  const top = v.rows[0];

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h2>Portfolio</h2>
          <div className="badges">
            <span className="badge">{p.broker}</span>
            <span className="badge" title={p.syncedAt?.toDate().toLocaleString()}>Synced {fmtAgo(p.syncedAt)}</span>
            {v.livePriced > 0 && <span className="badge public">{v.livePriced} of {v.rows.length} priced live</span>}
          </div>
        </div>
      </div>

      <p className="lede">
        Worth <b>{fmtMoney(v.value, cur)}</b>
        {v.dayPnl != null && (
          <>, <b className={tone(v.dayPnl)}>{fmtMoney(v.dayPnl, cur, true)}</b> on the day</>
        )}
        {v.drawdownPct != null && (
          <>, and <b>{v.drawdownPct < 0.005 ? "at its peak" : `${fmtPct(v.drawdownPct)} below its peak`}</b></>
        )}
        .{top && v.value > 0 && <> {top.p.symbol} is the largest holding at <b>{fmtPct((top.value / v.value) * 100)}</b>.</>}
      </p>

      <div className="kpis">
        <div className="card kpi">
          <div className="kpi-label">Value</div>
          <div className="kpi-value">{fmtMoney(v.value, cur)}</div>
          <div className="kpi-sub">Cash {fmtMoney(p.summary.cash, cur)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Day P&amp;L</div>
          <div className={`kpi-value ${tone(v.dayPnl)}`}>{fmtMoney(v.dayPnl, cur, true)}</div>
          <div className="kpi-sub">{dayPct == null ? "–" : fmtPct(dayPct, true)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Unrealized P&amp;L</div>
          <div className={`kpi-value ${tone(v.unrealizedPnl)}`}>{fmtMoney(v.unrealizedPnl, cur, true)}</div>
          <div className="kpi-sub">{fmtPct(unrPct, true)} on cost {fmtMoney(v.costBasis, cur)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Drawdown from peak</div>
          <div className={`kpi-value dd-${severity(v.drawdownPct)}`}>{v.drawdownPct == null ? "–" : v.drawdownPct < 0.005 ? "At peak" : `-${fmtPct(v.drawdownPct)}`}</div>
          <div className="kpi-sub">{v.peakDate ? `Peak ${fmtDay(v.peakDate)}` : "Time-weighted return"}</div>
        </div>
      </div>

      <section className="card">
        <div className="section-head">
          <h3>Return {rangeRet != null && <span className={tone(rangeRet)}>{fmtPct(rangeRet, true)}</span>}</h3>
          <div className="segmented" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>{r === "ALL" ? "All" : r}</button>
            ))}
          </div>
        </div>
        <ReturnChart points={series} currency={cur} />
        <p className="muted small-text">Time-weighted return from IBKR, so deposits and withdrawals do not count as gains or losses. History grows with every sync.</p>
      </section>

      <section>
        <div className="section-head"><h3>Holdings</h3></div>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num hide-sm">Qty</th>
                <th className="num">Price</th>
                <th className="num">Value</th>
                <th className="num hide-sm">Weight</th>
                <th className="num">Return</th>
                <th className="num hide-sm">Day</th>
                <th>From ATH</th>
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r) => {
                const dd = drawdownOf(r.quote, basis);
                const ath = athOf(r.quote, basis);
                return (
                  <tr key={r.p.symbol}>
                    <td>
                      <div className="sym">{r.p.symbol}</div>
                      <div className="muted small-text truncate">{r.quote?.name ?? r.p.brokerSymbol}</div>
                    </td>
                    <td className="num hide-sm">{fmtQty(r.p.quantity)}</td>
                    <td className="num">
                      {fmtMoney(r.price, r.p.currency)}
                      <div className="muted small-text">{r.live ? <span className="live">● live</span> : "at sync"}</div>
                    </td>
                    <td className="num">{fmtMoney(r.value, r.p.currency)}</td>
                    <td className="num hide-sm">{v.value ? fmtPct((r.value / v.value) * 100) : "–"}</td>
                    <td className={`num ${tone(r.returnPct)}`}>
                      {fmtPct(r.returnPct, true)}
                      <div className="small-text">{fmtMoney(r.unrealizedPnl, r.p.currency, true)}</div>
                    </td>
                    <td className={`num hide-sm ${tone(r.dayPnl)}`}>{fmtMoney(r.dayPnl, r.p.currency, true)}</td>
                    <td>
                      <div className={`dd dd-${severity(dd)}`} title={ath.value != null ? `ATH ${ath.value} on ${fmtDate(ath.date)}` : undefined}>
                        <span className="dd-value">{dd == null ? "–" : dd === 0 ? "At ATH" : `-${fmtPct(dd)}`}</span>
                        <span className="dd-bar"><span style={{ width: `${Math.min(100, (dd ?? 0) * 2)}%` }} /></span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col">
        <section className="card stack">
          <h3>Portfolio alerts</h3>
          <p className="muted small-text">Telegram and email when the portfolio falls this far below its peak, checked every 5 minutes with live prices.</p>
          <div className="row">
            <label className="toggle">
              <input type="checkbox" checked={p.alertsEnabled !== false} onChange={(e) => onAlerts({ alertsEnabled: e.target.checked })} />
              Alerts on
            </label>
            <span className={p.alertsEnabled === false ? "disabled" : ""}>
              <ThresholdEditor thresholds={p.thresholds ?? []} alertState={p.alertState} editable onSave={(t) => onAlerts({ thresholds: t })} />
            </span>
          </div>
          <p className="muted small-text">Channels follow your <Link to="/settings">Settings</Link>.</p>
        </section>

        <section className="card stack">
          <h3>Margin at last sync</h3>
          <dl className="metrics">
            <div><dt>Buying power</dt><dd>{fmtMoney(p.summary.buyingPower, cur)}</dd></div>
            <div><dt>Available funds</dt><dd>{fmtMoney(p.summary.availableFunds, cur)}</dd></div>
            <div><dt>Excess liquidity</dt><dd>{fmtMoney(p.summary.excessLiquidity, cur)}</dd></div>
            <div><dt>Maintenance margin</dt><dd>{fmtMoney(p.summary.maintenanceMargin, cur)}</dd></div>
            <div><dt>Leverage</dt><dd>{p.summary.leverage ?? "–"}</dd></div>
          </dl>
        </section>
      </div>

      <SyncHelp />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="stack-lg">
      <h2>Portfolio</h2>
      <div className="empty">
        <p>No portfolio synced yet.</p>
        <p className="muted">Your IBKR holdings are pushed here by Claude, using the IBKR connector and this app's MCP server.</p>
      </div>
      <SyncHelp open />
    </div>
  );
}

function SyncHelp({ open = false }: { open?: boolean }) {
  return (
    <details className="card" open={open}>
      <summary>How to sync from IBKR</summary>
      <ol className="steps">
        <li>In <Link to="/settings">Settings &gt; MCP access</Link>, create an API key and add Drawdown Monitor to Claude Desktop or Claude Code.</li>
        <li>Make sure the Interactive Brokers (IBKR) connector is on in Claude.</li>
        <li>Ask Claude: <i>"Sync my IBKR portfolio to Drawdown Monitor."</i> It reads your account summary, positions and performance from IBKR and saves them with <code>save_portfolio_snapshot</code>.</li>
        <li>Prices then update live every 5 minutes. Sync again after you trade, or set Claude to do it daily.</li>
      </ol>
    </details>
  );
}
