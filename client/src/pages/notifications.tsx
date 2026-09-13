import { useState } from 'react';
import { api, type NotificationChannel, type ChannelDef, type BackendField } from '../core/api';
import { Icon } from '../core/icons';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, BusyButton } from '../ui/primitives';
import { useT } from '../i18n';

export function Notifications() {
  const t = useT();
  const { data, loading, reload } = useAsync(() =>
    Promise.all([
      api.get<NotificationChannel[]>('/notification-channels'),
      api.get<ChannelDef[]>('/notification-channels/providers'),
    ]),
  );
  const { open } = useModal();

  if (loading || !data) return <Loading label={t.common.loading} />;
  const [channels, providers] = data;

  const newChannel = () =>
    open((close) => <ChannelEditor providers={providers} onClose={close} onSaved={reload} />);

  return (
    <div>
      <PageHeader
        title={t.notifications.title}
        subtitle={t.notifications.subtitle(channels.length)}
        actions={<ActionButton label={t.notifications.newChannel} icon="plus" variant="primary" onClick={newChannel} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{t.notifications.channels}</h2>
        </div>
        {channels.length === 0 ? (
          <Empty>{t.notifications.empty}</Empty>
        ) : (
          channels.map((c) => (
            <ChannelRow key={c.id} channel={c} providers={providers} reload={reload} />
          ))
        )}
      </div>
    </div>
  );
}

function ChannelRow({
  channel: c,
  providers,
  reload,
}: {
  channel: NotificationChannel;
  providers: ChannelDef[];
  reload: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { open, confirmDialog } = useModal();
  const provider = providers.find((p) => p.type === c.type);

  return (
    <div className="row">
      <span className={`status-dot ${c.enabled ? 'online' : 'offline'}`} />
      <span className="stat-icon" style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}>
        <Icon name="bell" size={16} />
      </span>
      <div className="row-main">
        <div className="row-title">{c.name}</div>
        <div className="row-sub">
          {`${provider?.label ?? c.type}${c.enabled ? '' : ` · ${t.notifications.disabled}`}`}
        </div>
      </div>
      <div className="row-actions">
        <BusyButton
          className="btn btn-ghost btn-sm"
          title={t.notifications.sendTest}
          busyLabel={t.notifications.testing}
          onClick={async () => {
            try {
              const res = await api.post<{ ok: boolean; message: string }>(
                `/notification-channels/${c.id}/test`,
              );
              toast(res.message, res.ok ? 'success' : 'error');
            } catch (err) {
              toast(err instanceof Error ? err.message : t.notifications.testFailed, 'error');
            }
          }}
        >
          {t.notifications.test}
        </BusyButton>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() =>
            open((close) => (
              <ChannelEditor providers={providers} channel={c} onClose={close} onSaved={reload} />
            ))
          }
        >
          <Icon name="edit" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() =>
            confirmDialog(
              t.notifications.deleteTitle,
              t.notifications.deleteConfirm(c.name),
              async () => {
                await api.del(`/notification-channels/${c.id}`);
                toast(t.notifications.deleted, 'success');
                reload();
              },
              true,
            )
          }
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

function ChannelFieldInput({
  field: f,
  value,
  onChange,
  isEdit,
}: {
  field: BackendField;
  value: string;
  onChange: (v: string) => void;
  isEdit: boolean;
}) {
  const t = useT();
  if (f.type === 'textarea') {
    return (
      <textarea
        name={f.name}
        placeholder={f.placeholder ?? ''}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (f.type === 'select' && f.options) {
    return (
      <select name={f.name} value={value} onChange={(e) => onChange(e.target.value)}>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  // Secret fields are never sent back to the client; show a placeholder on edit.
  const placeholder = f.secret && isEdit ? t.notifications.editor.leaveUnchanged : f.placeholder ?? '';
  return (
    <input
      name={f.name}
      type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ChannelEditor({
  providers,
  channel,
  onClose,
  onSaved,
}: {
  providers: ChannelDef[];
  channel?: NotificationChannel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const isEdit = !!channel;

  const [name, setName] = useState(channel?.name ?? '');
  const [type, setType] = useState(channel?.type ?? providers[0].type);
  const [enabled, setEnabled] = useState(channel ? channel.enabled : true);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const cfg = channel?.config ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg)) out[k] = v != null ? String(v) : '';
    return out;
  });

  const provider = providers.find((p) => p.type === type)!;
  const setValue = (n: string, v: string) => setValues((cur) => ({ ...cur, [n]: v }));

  const collect = (): Record<string, unknown> => {
    const config: Record<string, unknown> = {};
    for (const f of provider.fields) {
      const v = values[f.name];
      if (v != null && v !== '') config[f.name] = v;
    }
    return config;
  };

  const submit = async () => {
    try {
      if (isEdit) {
        await api.patch(`/notification-channels/${channel!.id}`, {
          name,
          config: collect(),
          enabled,
        });
      } else {
        await api.post('/notification-channels', {
          name,
          type,
          config: collect(),
          enabled,
        });
      }
      toast(t.notifications.editor.saved, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : t.notifications.editor.saveFailed, 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={isEdit ? t.notifications.editor.editTitle : t.notifications.editor.newTitle}
      confirmLabel={isEdit ? t.common.save : t.notifications.editor.create}
      onClose={onClose}
      onSubmit={submit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={t.notifications.editor.name}>
          <input type="text" value={name} placeholder={t.notifications.editor.namePlaceholder} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t.notifications.editor.provider}>
          <select name="__type" disabled={isEdit} value={type} onChange={(e) => setType(e.target.value)}>
            {providers.map((p) => (
              <option key={p.type} value={p.type}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {provider.fields.map((f) => (
            <Field key={f.name} label={f.label + (f.required ? ' *' : '')} help={f.help}>
              <ChannelFieldInput
                field={f}
                value={values[f.name] ?? ''}
                onChange={(v) => setValue(f.name, v)}
                isEdit={isEdit}
              />
            </Field>
          ))}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t.notifications.editor.enabled}
        </label>
      </div>
    </FormModal>
  );
}
