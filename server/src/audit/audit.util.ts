import { Request } from 'express';

/** Object keys whose values are secrets and must never be persisted. */
export const SECRET_KEY_RE =
  /pass(word)?|secret|token|credential|priv.?key|api.?key|access.?key|webhook/i;

/** Verb overrides for action-style sub-routes (e.g. POST /jobs/:id/run). */
const ACTION_VERBS: Record<string, string> = {
  run: 'Run',
  cancel: 'Cancel',
  rotate: 'Rotate token for',
  enable: 'Enable',
  disable: 'Disable',
  restore: 'Restore',
  retry: 'Retry',
  test: 'Test',
  resend: 'Resend',
  duplicate: 'Duplicate',
};

const METHOD_VERBS: Record<string, string> = {
  POST: 'Create',
  PUT: 'Update',
  PATCH: 'Update',
  DELETE: 'Delete',
};

const MAX_REDACT_DEPTH = 6;

export interface RouteMeta {
  action: string;
  resourceType: string | null;
  resourceId: string | null;
}

/** Naive English singularizer, good enough for REST collection names. */
export function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses')) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Derives a human-readable action label and the affected resource from a
 * request path + route params. Params are matched by value so real ids are
 * excluded from the static segments regardless of the route template.
 */
export function deriveAction(
  method: string,
  path: string,
  params: Record<string, string> = {},
): RouteMeta {
  const paramValues = new Set(Object.values(params));
  let parts = (path || '').split('/').filter(Boolean);
  if (parts[0] === 'api') parts = parts.slice(1);
  const staticParts = parts.filter((p) => !paramValues.has(p));

  const collection = staticParts[0] ?? 'resource';
  const tail = staticParts.slice(1);
  const last = tail[tail.length - 1];

  const resourceId =
    params.id ??
    params.jobId ??
    params.targetId ??
    Object.values(params)[0] ??
    null;

  // Account/session actions read better as plain verbs than "Create auth …".
  if (collection === 'auth') {
    const map: Record<string, string> = {
      logout: 'Log out',
      'change-password': 'Change password',
    };
    return {
      action: map[last] ?? `Account: ${tail.join(' ') || 'action'}`,
      resourceType: 'auth',
      resourceId: null,
    };
  }

  let action: string;
  if (last && ACTION_VERBS[last]) {
    action = `${ACTION_VERBS[last]} ${singular(collection)}`;
  } else {
    const verb = METHOD_VERBS[method] ?? method;
    const label = tail.length
      ? `${singular(collection)} ${tail.join(' ')}`
      : singular(collection);
    action = `${verb} ${label}`;
  }

  return {
    action,
    resourceType:
      collection && collection !== 'resource' ? singular(collection) : null,
    resourceId,
  };
}

/** Deep-clones a value, replacing secret-bearing fields with a marker. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value == null || depth > MAX_REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Best-effort client IP, honoring a reverse proxy's X-Forwarded-For. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? null;
}
