// Typed fetch wrapper around the Amber REST API. Session auth is cookie-based.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = Array.isArray(data.message)
        ? data.message.join(', ')
        : (data.message ?? message);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// --- Domain types (mirror server DTOs) ---

export interface User {
  id: string;
  email: string;
  display_name: string;
  auth_source: string;
  is_admin: boolean;
  disabled: boolean;
}

export interface Target {
  id: string;
  name: string;
  backend_type: string;
  config: Record<string, unknown>;
  owner_id: string;
}

export interface BackendField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}
export interface BackendDef {
  type: string;
  label: string;
  fields: BackendField[];
}

export interface JobNotify {
  channelIds?: string[];
  onSuccess?: boolean;
  onFailure?: boolean;
}

export interface Job {
  id: string;
  name: string;
  location: 'local' | 'agent';
  agent_id: string | null;
  paths: string[];
  target_id: string;
  cron_expr: string;
  restic_options: Record<string, unknown>;
  notify?: JobNotify;
  enabled: boolean;
  next_run?: string | null;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface ChannelDef {
  type: string;
  label: string;
  fields: BackendField[];
}

export interface ReportDataset {
  jobIds: string[];
  statuses: ('success' | 'failed')[];
  window: '24h' | '7d' | '30d' | '90d' | '6mo' | '12mo';
}

export interface Report {
  id: string;
  name: string;
  tags: string[];
  dataset: ReportDataset;
  cron_expr: string;
  channel_ids: string[];
  enabled: boolean;
  last_run_at: string | null;
  next_run?: string | null;
}

export interface Run {
  id: string;
  job_id: string;
  job_name?: string;
  trigger: string;
  status: string;
  agent_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  snapshot_id: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  hostname: string | null;
  os: string | null;
  status: string;
  last_seen_at: string | null;
  agent_version: string | null;
  restic_version: string | null;
  poll_interval_seconds: number;
}

export interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  tags?: string[];
  paths: string[];
}

export interface LsEntry {
  name: string;
  type: string;
  path: string;
  size?: number;
  mtime?: string;
}

export interface RestoreRun {
  id: string;
  target_id: string;
  snapshot_id: string;
  mode: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  download_expires_at: string | null;
  error: string | null;
  created_at: string;
}
