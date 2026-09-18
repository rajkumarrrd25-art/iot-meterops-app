// Centralized helpers for validating device lifecycle dates consistently
// across every Add/Update form (Receipt, Booking + Payment, Installation,
// Service, Disconnection). Single source of truth so "is this date in the
// future" and "does date A come before date B" are never re-implemented
// (and re-drifted) per component.
//
// Two date shapes are used across the app:
//   - date-only  : 'YYYY-MM-DD'       (native <input type="date">)
//   - date-time  : 'YYYY-MM-DDTHH:mm' (native <input type="datetime-local">)
//
// Everything here parses using LOCAL calendar/time components — never via
// `new Date(bareDateString)`, which JS parses as UTC midnight and can
// silently shift a valid "today" into "yesterday" (or "tomorrow") purely
// because of the browser's timezone offset. Both shapes are normalized the
// same way, so a date-only value and a date-time value can be compared
// directly (date-only == local midnight of that day).

function parseLocal(value: string | null | undefined): Date | null {
  if (!value) return null;
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return null;
  if (timePart) {
    const [hh, mm] = timePart.split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

// True when a date-only value is a calendar day after today (local).
export function isFutureDateOnly(value: string | null | undefined): boolean {
  const d = parseLocal(value);
  if (!d) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}

// True when a date-time value is strictly after the current moment.
export function isFutureDateTime(value: string | null | undefined): boolean {
  const d = parseLocal(value);
  if (!d) return false;
  return d.getTime() > Date.now();
}

// Compares two values of EITHER shape (date-only or date-time), normalized
// to local timestamps first, so a date-only field can be safely compared
// against a date-time field (e.g. Booking date vs Installation date&time).
// Returns <0 if a is earlier, >0 if a is later, 0 if equal or either side
// is unparseable (an unparseable/empty side never fails a comparison —
// required-ness is checked separately, before this is ever called).
export function compareLifecycleDates(a: string | null | undefined, b: string | null | undefined): number {
  const da = parseLocal(a);
  const db = parseLocal(b);
  if (!da || !db) return 0;
  return da.getTime() - db.getTime();
}
