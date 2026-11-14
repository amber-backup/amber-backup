/** Characters kept from the start of a truncated text (the rest is its tail). */
const HEAD_CHARS = 4096;
/** Room reserved for the truncation marker. */
const MARKER_RESERVE = 64;

/**
 * Shortens a text to at most `max` characters, keeping its start and its end
 * (where a log carries the final error) around a marker saying how much was
 * dropped. Shorter texts are returned unchanged.
 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= MARKER_RESERVE * 2) return value.slice(0, max);
  const head = Math.min(HEAD_CHARS, Math.floor(max / 4));
  const tail = max - head - MARKER_RESERVE;
  const dropped = value.length - head - tail;
  return `${value.slice(0, head)}\n… ${dropped} characters truncated …\n${value.slice(value.length - tail)}`;
}
