/**
 * Strict ISO date validation for tool inputs.
 *
 * Calendar math downstream compares plain strings, so garbage in stays
 * confidently ordered: "2026-13" silently returns notable-days, a past or
 * malformed untilDate reads as "no classes", and "30-10-2026" corrupts the
 * month slicing. Every tool that takes a date from the user validates here
 * and fails loud instead.
 */

/** True when s is a real calendar date in ISO YYYY-MM-DD form. */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Round-trip through UTC: rejects Feb 30, month 13, day 00/32, etc.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}

/** True when s is a real month in ISO YYYY-MM form. */
export function isIsoMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** Throw a plain, model-readable error for a bad date input. */
export function assertIsoDate(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!isIsoDate(value)) {
    throw new Error(
      `"${value}" is not a real calendar date for ${field}. Use ISO YYYY-MM-DD (e.g. 2026-10-20).`,
    );
  }
}

/** Throw a plain, model-readable error for a bad month input. */
export function assertIsoMonth(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!isIsoMonth(value)) {
    throw new Error(
      `"${value}" is not a real month for ${field}. Use ISO YYYY-MM (e.g. 2026-10).`,
    );
  }
}
