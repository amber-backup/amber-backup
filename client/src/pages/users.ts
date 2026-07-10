import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, User, Target, Job } from '../core/api';
import { router } from '../core/router';
import { openModal, toast, field, confirmDialog } from '../core/ui';

interface Grant {
  id: string;
  resource_type: string;
  resource_id: string;
  access_level: string;
}

export async function renderUsers(): Promise<Node> {
  const users = await api.get<User[]>('/users');

  const panel = h(
    'div',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Users')),
    ...users.map(userRow),
  );

  return h(
    'div',
    {},
    pageHeader('Users', `${users.length} accounts`, [
      actionButton('New user', 'plus', openCreate, 'primary'),
    ]),
    panel,
  );
}

function userRow(u: User): HTMLElement {
  const statusBadge = u.disabled
    ? h('span', { class: 'badge danger' }, u.auth_source !== 'local' ? 'SSO – approval needed' : 'disabled')
    : u.is_admin
      ? h('span', { class: 'badge warn' }, 'Administrator')
      : h('span', { class: 'badge success' }, 'active');

  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'stat-icon', style: 'background:var(--bg-3);color:var(--text-2)' }, icon('users', 16)),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, u.display_name),
      h('div', { class: 'row-sub' }, `${u.email} · ${u.auth_source}`),
    ),
    statusBadge,
    h(
      'div',
      { class: 'row-actions' },
      u.disabled
        ? h('button', {
            class: 'btn btn-primary btn-sm',
            onclick: async () => {
              await api.post(`/users/${u.id}/enable`);
              toast('User enabled', 'success');
              router.navigate('/users');
            },
          }, icon('check'), 'Enable')
        : (null as never),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openGrants(u), title: 'Grants' }, icon('key')),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openEdit(u) }, icon('edit')),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => confirmDialog('Delete user', `"${u.display_name}" will be removed.`, async () => {
          await api.del(`/users/${u.id}`);
          toast('User deleted', 'success');
          router.navigate('/users');
        }, true),
      }, icon('trash')),
    ),
  );
}

function openCreate(): void {
  const email = h('input', { type: 'email' });
  const name = h('input', { type: 'text' });
  const password = h('input', { type: 'password' });
  const admin = h('input', { type: 'checkbox' }) as HTMLInputElement;

  openModal({
    title: 'New user',
    body: h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
      field('Email', email),
      field('Display name', name),
      field('Password', password),
      h('label', { class: 'checkbox' }, admin, 'Administrator'),
    ),
    confirmLabel: 'Create',
    onConfirm: async () => {
      try {
        await api.post('/users', { email: email.value, displayName: name.value, password: password.value, isAdmin: admin.checked });
        toast('User created', 'success');
        router.navigate('/users');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Error', 'error');
        return false;
      }
    },
  });
}

function openEdit(u: User): void {
  const name = h('input', { type: 'text', value: u.display_name });
  const password = h('input', { type: 'password', placeholder: '(unchanged)' });
  const admin = h('input', { type: 'checkbox', checked: u.is_admin }) as HTMLInputElement;
  const disabled = h('input', { type: 'checkbox', checked: u.disabled }) as HTMLInputElement;

  openModal({
    title: 'Edit user',
    body: h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
      field('Display name', name),
      u.auth_source === 'local' ? field('New password', password) : (null as never),
      h('label', { class: 'checkbox' }, admin, 'Administrator'),
      h('label', { class: 'checkbox' }, disabled, 'Disabled'),
    ),
    onConfirm: async () => {
      const payload: Record<string, unknown> = { displayName: name.value, isAdmin: admin.checked, disabled: disabled.checked };
      if (password.value) payload.password = password.value;
      try {
        await api.patch(`/users/${u.id}`, payload);
        toast('Saved', 'success');
        router.navigate('/users');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Error', 'error');
        return false;
      }
    },
  });
}

async function openGrants(u: User): Promise<void> {
  const [grants, targets, jobs] = await Promise.all([
    api.get<Grant[]>(`/users/${u.id}/grants`),
    api.get<Target[]>('/targets'),
    api.get<Job[]>('/jobs'),
  ]);

  const resourceName = (type: string, id: string): string => {
    const pool = type === 'target' ? targets : jobs;
    return (pool as { id: string; name: string }[]).find((r) => r.id === id)?.name ?? id.slice(0, 8);
  };

  const listEl = h('div', {});
  const renderGrantList = (gs: Grant[]) => {
    listEl.replaceChildren(
      ...(gs.length === 0
        ? [h('div', { class: 'empty', style: 'padding:20px' }, 'No grants. Without a grant the user sees nothing.')]
        : gs.map((g) =>
            h('div', { class: 'row', style: 'padding:10px 0' },
              h('div', { class: 'row-main' },
                h('div', { class: 'row-title' }, `${g.resource_type}: ${resourceName(g.resource_type, g.resource_id)}`),
                h('div', { class: 'row-sub' }, g.access_level),
              ),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                await api.del(`/users/${u.id}/grants/${g.id}`);
                const updated = await api.get<Grant[]>(`/users/${u.id}/grants`);
                renderGrantList(updated);
              } }, icon('trash')),
            ),
          )),
    );
  };
  renderGrantList(grants);

  const typeSelect = h('select', {},
    h('option', { value: 'target' }, 'Target'),
    h('option', { value: 'job' }, 'Job'),
  );
  const resSelect = h('select', {});
  const levelSelect = h('select', {},
    h('option', { value: 'view' }, 'view (read)'),
    h('option', { value: 'operate' }, 'operate (trigger)'),
    h('option', { value: 'manage' }, 'manage (edit)'),
  );

  const fillResources = () => {
    const pool = typeSelect.value === 'target' ? targets : jobs;
    resSelect.replaceChildren(...(pool as { id: string; name: string }[]).map((r) => h('option', { value: r.id }, r.name)));
  };
  typeSelect.addEventListener('change', fillResources);
  fillResources();

  const addBtn = h('button', { class: 'btn btn-ghost' }, icon('plus'), 'Add grant');
  addBtn.addEventListener('click', async () => {
    try {
      await api.post(`/users/${u.id}/grants`, {
        resourceType: typeSelect.value,
        resourceId: resSelect.value,
        accessLevel: levelSelect.value,
      });
      const updated = await api.get<Grant[]>(`/users/${u.id}/grants`);
      renderGrantList(updated);
      toast('Grant added', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
  });

  openModal({
    title: `Grants – ${u.display_name}`,
    wide: true,
    body: h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
      listEl,
      h('div', { style: 'border-top:1px solid var(--border);padding-top:16px;display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'field-row' }, field('Type', typeSelect), field('Resource', resSelect)),
        field('Access', levelSelect),
        h('div', {}, addBtn),
      ),
    ),
  });
}
