export const DEFAULT_SUMMARY_HOUR = 8;
export const DEFAULT_TIME_ZONE = "Asia/Singapore";
/** The summary job runs this often, so summary times are chosen in steps of this many minutes. */
export const SUMMARY_STEP_MINUTES = 5;

/** Hour (0-23) and minute at `now` in an IANA time zone; falls back to the default zone if invalid. */
export function localTime(now: Date, timeZone: string | null | undefined): { hour: number; minute: number } {
  const fmt = (tz: string) => {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "numeric", hourCycle: "h23", timeZone: tz }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    return { hour: get("hour"), minute: get("minute") };
  };
  try {
    return fmt(timeZone || DEFAULT_TIME_ZONE);
  } catch {
    return fmt(DEFAULT_TIME_ZONE);
  }
}

/** True when `now` falls in the same 5-minute slot as hour:minute in the given zone. */
export function isSummaryTime(now: Date, timeZone: string | null | undefined, hour: number, minute: number): boolean {
  const t = localTime(now, timeZone);
  const slot = (m: number) => Math.floor(m / SUMMARY_STEP_MINUTES);
  return t.hour === hour && slot(t.minute) === slot(minute);
}
