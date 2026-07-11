import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, Target, BackendDef, BackendField } from '../core/api';
import { router } from '../core/router';
import { openModal, toast, field, confirmDialog } from '../core/ui';

export async function renderTargets(): Promise<Node> {
  const [targets, backends] = await Promise.all([
    api.get<Target[]>('/targets'),
    api.get<BackendDef[]>('/targets/backends'),
  ]);

  const list = h('div', { class: 'panel' });
  renderList(list, targets, backends);

  return h(
    'div',
    {},
    pageHeader('Targets', `${targets.length} repositories`, [
      actionButton('New target', 'plus', () => openEditor(backends), 'primary'),
    ]),
    list,
  );
}

function renderList(
  container: HTMLElement,
  targets: Target[],
  backends: BackendDef[],
): void {
  container.replaceChildren(
    h('div', { class: 'panel-head' }, h('h2', {}, 'Repositories')),
    ...(targets.length === 0
      ? [h('div', { class: 'empty' }, 'No targets yet. Create your first backup repository.')]
      : targets.map((t) => targetRow(t, backends))),
  );
}

function targetRow(t: Target, backends: BackendDef[]): HTMLElement {
  const backend = backends.find((b) => b.type === t.backend_type);
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'stat-icon', style: 'background:var(--amber-glow);color:var(--amber)' }, icon('target', 16)),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, t.name),
      h('div', { class: 'row-sub' }, backend?.label ?? t.backend_type),
    ),
    h(
      'div',
      { class: 'row-actions' },
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled', '');
            btn.textContent = 'Testing…';
            try {
              const res = await api.post<{ ok: boolean; message: string }>(`/targets/${t.id}/test`);
              toast(res.message, res.ok ? 'success' : 'error');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Test failed', 'error');
            } finally {
              btn.removeAttribute('disabled');
              btn.textContent = 'Test';
            }
          },
        },
        'Test',
      ),
      h('button', { class: 'btn btn-ghost btn-sm', title: 'Edit', onclick: () => openEditor(backends, t) }, icon('edit')),
      h('button', { class: 'btn btn-ghost btn-sm', title: 'Duplicate', onclick: () => openEditor(backends, t, true) }, icon('copy')),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          title: 'Delete',
          onclick: () =>
            confirmDialog(
              'Delete target',
              `"${t.name}" will be removed. The repository itself stays intact.`,
              async () => {
                await api.del(`/targets/${t.id}`);
                toast('Target deleted', 'success');
                router.navigate('/targets');
              },
              true,
            ),
        },
        icon('trash'),
      ),
    ),
  );
}

function fieldInput(f: BackendField, existing?: Record<string, unknown>): HTMLElement {
  const val = existing?.[f.name];
  if (f.type === 'textarea') {
    return h('textarea', { name: f.name, placeholder: f.placeholder ?? '' }, val ? String(val) : '');
  }
  if (f.type === 'select' && f.options) {
    return h(
      'select',
      { name: f.name },
      ...f.options.map((o) => h('option', { value: o.value, selected: val === o.value }, o.label)),
    );
  }
  return h('input', {
    name: f.name,
    type: f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text',
    placeholder: f.placeholder ?? '',
    value: val != null ? String(val) : '',
  });
}

function openEditor(backends: BackendDef[], target?: Target, duplicate = false): void {
  // Duplicate: prefill from an existing target but create a new one (POST).
  // Secret config fields aren't returned by the API, so they start empty and
  // must be re-entered — as does the repository password.
  const isEdit = !!target && !duplicate;
  const isDuplicate = !!target && duplicate;
  const nameInput = h('input', {
    type: 'text',
    value: isDuplicate ? `Copy of ${target!.name}` : (target?.name ?? ''),
    placeholder: 'My backup target',
  });
  const passwordInput = h('input', {
    type: 'password',
    placeholder: isEdit ? '(leave unchanged)' : 'Repository password',
  });

  const typeSelect = h(
    'select',
    { name: '__type', disabled: isEdit },
    ...backends.map((b) => h('option', { value: b.type, selected: target?.backend_type === b.type }, b.label)),
  );

  const fieldsWrap = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const buildFields = (type: string) => {
    const backend = backends.find((b) => b.type === type)!;
    fieldsWrap.replaceChildren(
      ...backend.fields.map((f) => field(f.label + (f.required ? ' *' : ''), fieldInput(f, target?.config), f.help)),
    );
  };
  buildFields(target?.backend_type ?? backends[0].type);
  typeSelect.addEventListener('change', () => buildFields(typeSelect.value));

  const collect = () => {
    const config: Record<string, unknown> = {};
    fieldsWrap.querySelectorAll('input,select,textarea').forEach((el) => {
      const input = el as HTMLInputElement;
      if (input.value !== '') config[input.name] = input.value;
    });
    return config;
  };

  const testBtn = h('button', { class: 'btn btn-ghost' }, 'Test connection');
  testBtn.addEventListener('click', async () => {
    testBtn.setAttribute('disabled', '');
    try {
      const res = await api.post<{ ok: boolean; message: string }>('/targets/test', {
        name: nameInput.value || 'test',
        backendType: typeSelect.value,
        repoPassword: passwordInput.value || 'test',
        config: collect(),
      });
      toast(res.message, res.ok ? 'success' : 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test failed', 'error');
    } finally {
      testBtn.removeAttribute('disabled');
    }
  });

  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:16px' },
    field('Name', nameInput),
    field('Backend', typeSelect),
    field(isEdit ? 'Change repository password' : 'Repository password', passwordInput),
    fieldsWrap,
    h('div', {}, testBtn),
  );

  openModal({
    title: isEdit ? 'Edit target' : isDuplicate ? 'Duplicate target' : 'New target',
    body,
    confirmLabel: isEdit ? 'Save' : 'Create',
    onConfirm: async () => {
      try {
        if (isEdit) {
          const payload: Record<string, unknown> = { name: nameInput.value, config: collect() };
          if (passwordInput.value) payload.repoPassword = passwordInput.value;
          await api.patch(`/targets/${target!.id}`, payload);
        } else {
          await api.post('/targets', {
            name: nameInput.value,
            backendType: typeSelect.value,
            repoPassword: passwordInput.value,
            config: collect(),
          });
        }
        toast('Target saved', 'success');
        router.navigate('/targets');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Save failed', 'error');
        return false;
      }
    },
  });
}
