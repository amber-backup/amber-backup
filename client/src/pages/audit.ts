import { h } from '../core/dom';
import { pageHeader } from '../core/layout';
import { api } from '../core/api';
import { openModal, fmtDateTime, fmtRelative } from '../core/ui';

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

/** Admin-only audit log: paginated table, click a row for full details. */
export async function renderAuditLog(): Promise<Node> {
  const state = { page: 1, search: '', outcome: '' };
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const panel = h('div', { class: 'panel' });
  const pager = h('div', {
    style:
      'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-top:1px solid var(--border)',
  });

  const load = async (): Promise<void> => {
    panel.replaceChildren(
      h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading…'),
    );
    pager.replaceChildren();

    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: '25',
    });
    if (state.search) params.set('search', state.search);
    if (state.outcome) params.set('outcome', state.outcome);

    let data: AuditPage;
    try {
      data = await api.get<AuditPage>(`/audit?${params.toString()}`);
    } catch {
      panel.replaceChildren(
        h('div', { class: 'empty' }, 'Failed to load the audit log.'),
      );
      return;
    }

    const head = h(
      'div',
      { class: 'table-head', style: GRID },
      h('span', {}, 'Time'),
      h('span', {}, 'Actor'),
      h('span', {}, 'Action'),
      h('span', {}, 'Resource'),
      h('span', {}, 'Status'),
    );

    const rows =
      data.items.length === 0
        ? [h('div', { class: 'empty' }, 'No audit entries match.')]
        : data.items.map(auditRow);

    panel.replaceChildren(head, ...rows);
    renderPager(data);
  };

  const renderPager = (data: AuditPage): void => {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.page * data.pageSize, data.total);

    const prev = h('button', { class: 'btn btn-ghost btn-sm' }, '‹ Prev');
    const next = h('button', { class: 'btn btn-ghost btn-sm' }, 'Next ›');
    if (data.page <= 1) prev.setAttribute('disabled', '');
    if (data.page >= totalPages) next.setAttribute('disabled', '');
    prev.addEventListener('click', () => {
      if (state.page > 1) {
        state.page--;
        void load();
      }
    });
    next.addEventListener('click', () => {
      if (state.page < totalPages) {
        state.page++;
        void load();
      }
    });

    pager.replaceChildren(
      h(
        'span',
        { style: 'font-size:12.5px;color:var(--text-3)' },
        data.total === 0
          ? 'No entries'
          : `${from}–${to} of ${data.total}`,
      ),
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:10px' },
        prev,
        h(
          'span',
          { style: 'font-size:12.5px;color:var(--text-2)' },
          `Page ${data.page} / ${totalPages}`,
        ),
        next,
      ),
    );
  };

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search action, actor, path…',
    style: 'max-width:280px;flex:1',
  }) as HTMLInputElement;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = search.value.trim();
      state.page = 1;
      void load();
    }, 300);
  });

  const outcome = h(
    'select',
    { class: 'select', style: 'max-width:160px' },
    h('option', { value: '' }, 'All outcomes'),
    h('option', { value: 'success' }, 'Success'),
    h('option', { value: 'failure' }, 'Failure'),
  ) as HTMLSelectElement;
  outcome.addEventListener('change', () => {
    state.outcome = outcome.value;
    state.page = 1;
    void load();
  });

  const toolbar = h(
    'div',
    { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px' },
    search,
    outcome,
  );

  void load();

  return h(
    'div',
    {},
    pageHeader('Audit Log', 'Writes and operations by users, admins, and API keys'),
    toolbar,
    h('div', {}, panel, pager),
  );
}

function auditRow(e: AuditEntry): HTMLElement {
  const row = h('div', {
    class: 'row',
    style: `display:grid;${GRID};gap:14px;cursor:pointer;align-items:center`,
    title: 'Click for details',
  });
  row.append(
    h(
      'div',
      { style: 'min-width:0' },
      h('div', { style: 'font-size:12.5px;color:var(--text-2)' }, fmtRelative(e.created_at)),
      h('div', { class: 'row-sub' }, fmtDateTime(e.created_at)),
    ),
    h(
      'div',
      { style: 'min-width:0' },
      h('div', { class: 'row-title' }, e.actor_email ?? '—'),
      h('div', { class: 'row-sub' }, actorKind(e)),
    ),
    h('div', { class: 'row-title', style: 'white-space:normal' }, e.action),
    h(
      'div',
      { class: 'mono', style: 'font-size:12px;color:var(--text-3);min-width:0;overflow:hidden;text-overflow:ellipsis' },
      e.resource_type
        ? `${e.resource_type}${e.resource_id ? ` · ${short(e.resource_id)}` : ''}`
        : '—',
    ),
    outcomeBadge(e),
  );
  row.addEventListener('click', () => openDetail(e));
  return row;
}

function actorKind(e: AuditEntry): string {
  if (e.actor_type === 'apikey') return 'API key';
  return e.actor_is_admin ? 'Administrator' : 'User';
}

function outcomeBadge(e: AuditEntry): HTMLElement {
  const cls = e.outcome === 'failure' ? 'danger' : 'success';
  const label = e.status_code ? String(e.status_code) : e.outcome;
  return h('span', { class: `badge ${cls}` }, label);
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function openDetail(e: AuditEntry): void {
  const rows: Node[] = [
    def('Time', fmtDateTime(e.created_at)),
    def('Action', e.action),
    def('Outcome', e.outcome + (e.status_code ? ` (${e.status_code})` : '')),
    def('Actor', e.actor_email ?? '—'),
    def('Actor type', actorKind(e)),
    e.method || e.path ? def('Request', `${e.method ?? ''} ${e.path ?? ''}`.trim()) : null,
    e.resource_type ? def('Resource', `${e.resource_type}${e.resource_id ? ` · ${e.resource_id}` : ''}`) : null,
    e.ip ? def('IP address', e.ip) : null,
    e.user_agent ? def('User agent', e.user_agent) : null,
  ].filter(Boolean) as Node[];

  const body = h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, ...rows);

  if (e.details && Object.keys(e.details).length) {
    body.append(
      h('div', { style: 'font-size:12.5px;color:var(--text-2);font-weight:500;margin-top:6px' }, 'Details'),
      h(
        'pre',
        {
          class: 'mono',
          style:
            'background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;overflow:auto;max-height:340px;white-space:pre-wrap;word-break:break-word',
        },
        JSON.stringify(e.details, null, 2),
      ),
    );
  }

  openModal({ title: e.action, body, wide: true });
}

function def(label: string, value: string): HTMLElement {
  return h(
    'div',
    { style: 'display:grid;grid-template-columns:130px 1fr;gap:12px;align-items:baseline' },
    h('div', { style: 'font-size:12.5px;color:var(--text-3)' }, label),
    h('div', { style: 'font-size:13px;color:var(--text-1);word-break:break-word' }, value),
  );
}
