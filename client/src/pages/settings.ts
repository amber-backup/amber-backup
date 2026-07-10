import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api } from '../core/api';
import { auth } from '../core/auth';
import { openModal, toast, field, confirmDialog, fmtRelative } from '../core/ui';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: { actions: string[] };
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export async function renderSettings(): Promise<Node> {
  const keys = await api.get<ApiKey[]>('/api-keys');

  const profilePanel = h(
    'div',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Profile')),
    h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, auth.user?.display_name ?? ''),
        h('div', { class: 'row-sub' }, `${auth.user?.email} · ${auth.isAdmin ? 'Administrator' : 'User'}`),
      ),
    ),
  );

  const keysPanel = h('div', { class: 'panel section-gap' });
  const renderKeys = (list: ApiKey[]) => {
    keysPanel.replaceChildren(
      h('div', { class: 'panel-head' },
        h('h2', {}, 'API keys'),
        h('span', { class: 'link', onclick: openCreateKey }, '+ New key'),
      ),
      ...(list.length === 0
        ? [h('div', { class: 'empty' }, 'No API keys. Create one for third-party applications.')]
        : list.map(keyRow)),
    );
  };

  function keyRow(k: ApiKey): HTMLElement {
    return h('div', { class: 'row' },
      h('span', { class: 'stat-icon', style: 'background:var(--bg-3);color:var(--text-2)' }, icon('key', 16)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, k.name),
        h('div', { class: 'row-sub' }, `${k.prefix}… · actions: ${k.scopes.actions.join(', ')} · last used ${fmtRelative(k.last_used_at)}`),
      ),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => confirmDialog('Revoke key', `"${k.name}" becomes invalid immediately.`, async () => {
          await api.del(`/api-keys/${k.id}`);
          toast('Key revoked', 'success');
          renderKeys(await api.get<ApiKey[]>('/api-keys'));
        }, true),
      }, icon('trash')),
    );
  }

  function openCreateKey(): void {
    const name = h('input', { type: 'text', placeholder: 'e.g. CI pipeline' });
    const actions: Record<string, HTMLInputElement> = {};
    const actionRow = ['read', 'operate', 'manage'].map((a) => {
      const cb = h('input', { type: 'checkbox', checked: a === 'read' }) as HTMLInputElement;
      actions[a] = cb;
      return h('label', { class: 'checkbox' }, cb, a);
    });
    const expiry = h('input', { type: 'number', placeholder: 'Days until expiry (blank = never)' });

    openModal({
      title: 'Create API key',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
        field('Name', name),
        field('Scopes', h('div', { style: 'display:flex;gap:16px' }, ...actionRow)),
        field('Expiry', expiry),
      ),
      confirmLabel: 'Create',
      onConfirm: async () => {
        const selectedActions = Object.entries(actions).filter(([, cb]) => cb.checked).map(([a]) => a);
        try {
          const res = await api.post<{ key: string; name: string }>('/api-keys', {
            name: name.value,
            scopes: { actions: selectedActions.length ? selectedActions : ['read'] },
            expiresInDays: expiry.value ? Number(expiry.value) : undefined,
          });
          renderKeys(await api.get<ApiKey[]>('/api-keys'));
          showKeyOnce(res.key);
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Error', 'error');
          return false;
        }
      },
    });
  }

  function showKeyOnce(key: string): void {
    const keyBox = h('div', {
      class: 'mono',
      style: 'background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;word-break:break-all;color:var(--amber-light)',
    }, key);
    const copyBtn = h('button', { class: 'btn btn-ghost btn-sm' }, icon('copy'), 'Copy');
    copyBtn.addEventListener('click', () => { void navigator.clipboard.writeText(key); toast('Copied', 'success'); });
    openModal({
      title: 'API key created',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'warn-box' }, 'This key is shown only once. Copy it now.'),
        keyBox,
        h('div', {}, copyBtn),
      ),
    });
  }

  renderKeys(keys);

  return h('div', {},
    pageHeader('Settings', 'Profile, API keys and SSO', [
      actionButton('Sign out', 'logout', async () => { await auth.logout(); location.reload(); }, 'ghost'),
    ]),
    profilePanel,
    keysPanel,
  );
}
