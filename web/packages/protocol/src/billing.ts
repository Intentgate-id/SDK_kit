/**
 * Billing unit: one (worker, site, local calendar day) per tenant.
 * Several entries and exits by the same worker at the same site on the same
 * day count once. The day is the server's issue time of the check-in in the
 * site's time zone.
 */

export interface BillableEvent {
  tenantId: string;
  siteId: string;
  workerId: string;
  /** Server time the check-in was issued, unix seconds. */
  time: number;
  /** IANA time zone of the site, e.g. "Asia/Tokyo". */
  timeZone: string;
}

export interface UsageRow {
  tenantId: string;
  siteId: string;
  workerId: string;
  /** Local date at the site, YYYY-MM-DD. */
  date: string;
  /** Number of verified billable events folded into this row. */
  events: number;
}

export function localDate(unixSeconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function billingKey(e: BillableEvent): string {
  return [e.tenantId, e.siteId, e.workerId, localDate(e.time, e.timeZone)].join("|");
}

/** Folds verified billable events into worker × site × day rows. */
export function aggregateUsage(events: Iterable<BillableEvent>): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const e of events) {
    const key = billingKey(e);
    const row = rows.get(key);
    if (row) {
      row.events += 1;
    } else {
      rows.set(key, {
        tenantId: e.tenantId,
        siteId: e.siteId,
        workerId: e.workerId,
        date: localDate(e.time, e.timeZone),
        events: 1,
      });
    }
  }
  return [...rows.values()].sort((a, b) =>
    a.tenantId.localeCompare(b.tenantId) || a.date.localeCompare(b.date) ||
    a.siteId.localeCompare(b.siteId) || a.workerId.localeCompare(b.workerId),
  );
}
