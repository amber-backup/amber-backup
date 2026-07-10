import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, NotificationChannel, ChannelDef, BackendField } from '../core/api';
import { router } from '../core/router';
import { openModal, toast, field, confirmDialog } from '../core/ui';

export async function renderNotifications(): Promise<Node> {
  const [channels, providers] = await Promise.all([
    api.get<NotificationChannel[]>('/notification-channels'),
    api.get<ChannelDef[]>('/notification-channels/providers'),
  ]);

  const list = h('div', { class: 'panel' });
  renderList(list, channels, providers);

  return h(
    'div',
    {},
    pageHeader('Notifications', `${channels.length} channels · alert on job success or failure`, [
      actionButton('New channel', 'plus', () => openEditor(providers), 'primary'),
    ]),
    list,
  );
}

function renderList(
  container: HTMLElement,
  channels: NotificationChannel[],
  providers: ChannelDef[],
): void {
  container.replaceChildren(
    h('div', { class: 'panel-head' }, h('h2', {}, 'Channels')),
    ...(channels.length === 0
      ? [h('div', { class: 'empty' }, 'No channels yet. Add email, Slack, Discord, Telegram, Teams, Gotify or a webhook — then attach them to jobs.')]
      : channels.map((c) => channelRow(c, providers))),
  );
}

function channelRow(c: NotificationChannel, providers: ChannelDef[]): HTMLElement {
  const provider = providers.find((p) => p.type === c.type);
  return h(
    'div',
    { class: 'row' },
    h('span', { class: `status-dot ${c.enabled ? 'online' : 'offline'}` }),
    h('span', { class: 'stat-icon', style: 'background:var(--amber-glow);color:var(--amber)' }, icon('bell', 16)),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, c.name),
      h('div', { class: 'row-sub' }, `${provider?.label ?? c.type}${c.enabled ? '' : ' · disabled'}`),
    ),
    h(
      'div',
      { class: 'row-actions' },
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          title: 'Send a test notification',
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled', '');
            const original = btn.textContent;
            btn.textContent = 'Testing…';
            try {
              const res = await api.post<{ ok: boolean; message: string }>(`/notification-channels/${c.id}/test`);
              toast(res.message, res.ok ? 'success' : 'error');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Test failed', 'error');
            } finally {
              btn.removeAttribute('disabled');
              btn.textContent = original;
            }
          },
        },
        'Test',
      ),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openEditor(providers, c) }, icon('edit')),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          onclick: () =>
            confirmDialog(
              'Delete channel',
              `"${c.name}" will be removed and detached from all jobs.`,
              async () => {
                await api.del(`/notification-channels/${c.id}`);
                toast('Channel deleted', 'success');
                router.navigate('/notifications');
              },
              true,
            ),
        },
        icon('trash'),
      ),
    ),
  );
}

function fieldInput(f: BackendField, existing?: Record<string, unknown>, isEdit = false): HTMLElement {
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
  // Secret fields are never sent back to the client; show a placeholder on edit.
  const placeholder = f.secret && isEdit ? '(leave unchanged)' : f.placeholder ?? '';
  return h('input', {
    name: f.name,
    type: f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text',
    placeholder,
    value: val != null ? String(val) : '',
  });
}

function openEditor(providers: ChannelDef[], channel?: NotificationChannel): void {
  const isEdit = !!channel;
  const nameInput = h('input', { type: 'text', value: channel?.name ?? '', placeholder: 'e.g. Ops Slack' });
  const typeSelect = h(
    'select',
    { name: '__type', disabled: isEdit },
    ...providers.map((p) => h('option', { value: p.type, selected: channel?.type === p.type }, p.label)),
  );
  const enabledCheck = h('input', { type: 'checkbox', checked: channel ? channel.enabled : true }) as HTMLInputElement;

  const fieldsWrap = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const buildFields = (type: string) => {
    const provider = providers.find((p) => p.type === type)!;
    fieldsWrap.replaceChildren(
      ...provider.fields.map((f) =>
        field(f.label + (f.required ? ' *' : ''), fieldInput(f, channel?.config, isEdit), f.help),
      ),
    );
  };
  buildFields(channel?.type ?? providers[0].type);
  typeSelect.addEventListener('change', () => buildFields(typeSelect.value));

  const collect = () => {
    const config: Record<string, unknown> = {};
    fieldsWrap.querySelectorAll('input,select,textarea').forEach((el) => {
      const input = el as HTMLInputElement;
      if (input.value !== '') config[input.name] = input.value;
    });
    return config;
  };

  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:16px' },
    field('Name', nameInput),
    field('Provider', typeSelect),
    fieldsWrap,
    h('label', { class: 'checkbox' }, enabledCheck, 'Channel enabled'),
  );

  openModal({
    title: isEdit ? 'Edit channel' : 'New channel',
    body,
    confirmLabel: isEdit ? 'Save' : 'Create',
    onConfirm: async () => {
      try {
        if (isEdit) {
          await api.patch(`/notification-channels/${channel!.id}`, {
            name: nameInput.value,
            config: collect(),
            enabled: enabledCheck.checked,
          });
        } else {
          await api.post('/notification-channels', {
            name: nameInput.value,
            type: typeSelect.value,
            config: collect(),
            enabled: enabledCheck.checked,
          });
        }
        toast('Channel saved', 'success');
        router.navigate('/notifications');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Save failed', 'error');
        return false;
      }
    },
  });
}
