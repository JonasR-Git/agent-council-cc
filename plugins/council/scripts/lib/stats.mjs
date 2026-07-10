// Numeric helpers shared across metrics / benchmark / solve / the companion.

/** Median of an array (sorted internally); null when empty. */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Mean of the finite numbers, rounded to one decimal; null when none. */
export function avg(nums) {
  const valid = nums.filter((n) => Number.isFinite(n));
  return valid.length ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10 : null;
}

/** Clamp a numeric score into [min, max]; null when the value is not finite. */
export function clampScore(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
