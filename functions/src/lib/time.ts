export const DEFAULT_SUMMARY_HOUR = 8;
export const DEFAULT_TIME_ZONE = "Asia/Singapore";

/** Hour of day (0-23) at `now` in an IANA time zone; falls back to the default zone if invalid. */
export function localHour(now: Date, timeZone: string | null | undefined): number {
  const fmt = (tz: string) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
  try {
    return fmt(timeZone || DEFAULT_TIME_ZONE);
  } catch {
    return fmt(DEFAULT_TIME_ZONE);
  }
}
