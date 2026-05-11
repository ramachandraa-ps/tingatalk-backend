// ============================================================================
// Date utilities — single source of truth for date keys used in Firestore.
// ============================================================================

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30

/**
 * Returns the IST calendar date as a YYYY-MM-DD string for the given Date
 * (defaults to "now"). Used for `female_earnings/{userId}/daily/{dateKey}`
 * documents so that the per-day bucket aligns with the user's IST clock.
 *
 * Why IST and not UTC: the app's user base is India (UTC+5:30). The frontend
 * uses local-device time (IST) when reading "today's earnings", so the
 * backend must use the same timezone when writing — otherwise calls
 * between IST 12:00 AM and IST 5:30 AM get filed under yesterday's UTC date
 * and the female sees "today earnings = 0" until UTC catches up.
 *
 * Implementation note: we explicitly add 5h30m to UTC, then call
 * toISOString() and split on 'T'. We don't rely on the server's local
 * timezone (which is typically UTC on the VPS) — this works correctly
 * regardless of where the server is hosted.
 *
 * @param {Date} [date] - the moment to convert. Defaults to current time.
 * @returns {string} YYYY-MM-DD in IST timezone (e.g., "2026-05-09")
 */
export function getISTDateKey(date) {
  const d = date || new Date();
  const istMs = d.getTime() + IST_OFFSET_MS;
  return new Date(istMs).toISOString().split('T')[0];
}
