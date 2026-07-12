import { useEffect, useState } from 'react';
import { api } from '../core/api';
import { fmtDateTime, fmtRelative } from '../core/format';
import { useModal, ModalFrame } from '../ui/modal';
import { PageHeader, Loading, Empty } from '../ui/primitives';
import { useAsync } from '../hooks/useAsync';

interface AuditEntry {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_type: string;
  actor_is_admin: boolean;
  action: string;
  method: string | null;
  path: string | null;
  resource_type: string | null;
  resource_id: string | null;
  status_code: number | null;
  outcome: 'success' | 'failure';
  ip: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
}

interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

const GRID = 'grid-template-columns:158px 1.1fr 1.3fr 1fr 78px';
const GRID_COLS = GRID.slice(GRID.indexOf(':') + 1);

/** Admin-only audit log: paginated table, click a row for full details. */
export function AuditLog() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [outcome, setOutcome] = useState('');
  const { open } = useModal();

  // Debounce the search input; changing the query resets to the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, loading, error } = useAsync(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: '25',
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (outcome) params.set('outcome', outcome);
    return api.get<AuditPage>(`/audit?${params.toString()}`);
  }, [page, debouncedSearch, outcome]);

  const openDetail = (e: AuditEntry) => {
    open((close) => <AuditDetail entry={e} onClose={close} />);
  };

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Writes and operations by users, admins, and API keys"
      />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          className="input"
          type="search"
          placeholder="Search action, actor, path…"
          style={{ maxWidth: 280, flex: 1 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select"
          style={{ maxWidth: 160 }}
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
      </div>
      <div>
        <div className="panel">
          {loading ? (
            <Loading label="Loading…" />
          ) : error || !data ? (
            <Empty>Failed to load the audit log.</Empty>
          ) : (
            <>
              <div className="table-head" style={{ gridTemplateColumns: GRID_COLS }}>
                <span>Time</span>
                <span>Actor</span>
                <span>Action</span>
                <span>Resource</span>
                <span>Status</span>
              </div>
              {data.items.length === 0 ? (
                <div className="empty">No audit entries match.</div>
              ) : (
                data.items.map((e) => (
                  <AuditRow key={e.id} entry={e} onOpen={openDetail} />
                ))
              )}
            </>
          )}
        </div>
        {!loading && !error && data && (
          <Pager data={data} onPage={setPage} />
        )}
      </div>
    </div>
  );
}

function Pager({ data, onPage }: { data: AuditPage; onPage: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.page * data.pageSize, data.total);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 20px',
        borderTop: '1px solid var(--border)',
      }}
    >
      <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
        {data.total === 0 ? 'No entries' : `${from}–${to} of ${data.total}`}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          className="btn btn-ghost btn-sm"
          disabled={data.page <= 1}
          onClick={() => {
            if (data.page > 1) onPage(data.page - 1);
          }}
        >
          ‹ Prev
        </button>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
          {`Page ${data.page} / ${totalPages}`}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          disabled={data.page >= totalPages}
          onClick={() => {
            if (data.page < totalPages) onPage(data.page + 1);
          }}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}

function AuditRow({
  entry: e,
  onOpen,
}: {
  entry: AuditEntry;
  onOpen: (e: AuditEntry) => void;
}) {
  return (
    <div
      className="row"
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLS,
        gap: 14,
        cursor: 'pointer',
        alignItems: 'center',
      }}
      title="Click for details"
      onClick={() => onOpen(e)}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{fmtRelative(e.created_at)}</div>
        <div className="row-sub">{fmtDateTime(e.created_at)}</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="row-title">{e.actor_email ?? '—'}</div>
        <div className="row-sub">{actorKind(e)}</div>
      </div>
      <div className="row-title" style={{ whiteSpace: 'normal' }}>
        {e.action}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 12,
          color: 'var(--text-3)',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {e.resource_type
          ? `${e.resource_type}${e.resource_id ? ` · ${short(e.resource_id)}` : ''}`
          : '—'}
      </div>
      {outcomeBadge(e)}
    </div>
  );
}

function actorKind(e: AuditEntry): string {
  if (e.actor_type === 'apikey') return 'API key';
  return e.actor_is_admin ? 'Administrator' : 'User';
}

function outcomeBadge(e: AuditEntry) {
  const cls = e.outcome === 'failure' ? 'danger' : 'success';
  const label = e.status_code ? String(e.status_code) : e.outcome;
  return <span className={`badge ${cls}`}>{label}</span>;
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function AuditDetail({ entry: e, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const rows = [
    def('Time', fmtDateTime(e.created_at)),
    def('Action', e.action),
    def('Outcome', e.outcome + (e.status_code ? ` (${e.status_code})` : '')),
    def('Actor', e.actor_email ?? '—'),
    def('Actor type', actorKind(e)),
    e.method || e.path ? def('Request', `${e.method ?? ''} ${e.path ?? ''}`.trim()) : null,
    e.resource_type
      ? def('Resource', `${e.resource_type}${e.resource_id ? ` · ${e.resource_id}` : ''}`)
      : null,
    e.ip ? def('IP address', e.ip) : null,
    e.user_agent ? def('User agent', e.user_agent) : null,
  ].filter(Boolean);

  const hasDetails = e.details && Object.keys(e.details).length > 0;

  return (
    <ModalFrame
      title={e.action}
      wide
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{rows}</div>
      {hasDetails && (
        <>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--text-2)',
              fontWeight: 500,
              marginTop: 6,
            }}
          >
            Details
          </div>
          <pre
            className="mono"
            style={{
              background: 'var(--bg-0)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 14px',
              fontSize: 12,
              overflow: 'auto',
              maxHeight: 340,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {JSON.stringify(e.details, null, 2)}
          </pre>
        </>
      )}
    </ModalFrame>
  );
}

function def(label: string, value: string) {
  return (
    <div
      key={label}
      style={{
        display: 'grid',
        gridTemplateColumns: '130px 1fr',
        gap: 12,
        alignItems: 'baseline',
      }}
    >
      <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--text-1)', wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}
