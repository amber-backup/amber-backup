/**
 * Client-side list search: every whitespace-separated term of `query` must occur
 * (case-insensitively) in at least one of `fields`. An empty query matches all.
 */
export function matchesSearch(query: string, fields: (string | null | undefined)[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields.filter(Boolean).join('\n').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
