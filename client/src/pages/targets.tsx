import { useState } from 'react';
import { api, type Target, type BackendDef, type BackendField } from '../core/api';
import { Icon } from '../core/icons';
import { copyToClipboard } from '../core/clipboard';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, BusyButton } from '../ui/primitives';

export function Targets() {
  const { data, loading, reload } = useAsync(() =>
    Promise.all([api.get<Target[]>('/targets'), api.get<BackendDef[]>('/targets/backends')]),
  );
  const { open } = useModal();

  if (loading || !data) return <Loading label="Loading…" />;
  const [targets, backends] = data;

  const newTarget = () =>
    open((close) => <TargetEditor backends={backends} onClose={close} onSaved={reload} />);

  return (
    <div>
      <PageHeader
        title="Targets"
        subtitle={`${targets.length} repositories`}
        actions={<ActionButton label="New target" icon="plus" variant="primary" onClick={newTarget} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>Repositories</h2>
        </div>
        {targets.length === 0 ? (
          <Empty>No targets yet. Create your first backup repository.</Empty>
        ) : (
          targets.map((t) => (
            <TargetRow key={t.id} target={t} backends={backends} reload={reload} />
          ))
        )}
      </div>
    </div>
  );
}

function TargetRow({
  target: t,
  backends,
  reload,
}: {
  target: Target;
  backends: BackendDef[];
  reload: () => void;
}) {
  const toast = useToast();
  const { open, confirmDialog } = useModal();
  const backend = backends.find((b) => b.type === t.backend_type);

  return (
    <div className="row">
      <span className="stat-icon" style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}>
        <Icon name="target" size={16} />
      </span>
      <div className="row-main">
        <div className="row-title">{t.name}</div>
        <div className="row-sub">{backend?.label ?? t.backend_type}</div>
      </div>
      <div className="row-actions">
        <BusyButton
          className="btn btn-ghost btn-sm"
          busyLabel="Testing…"
          onClick={async () => {
            try {
              const res = await api.post<{ ok: boolean; message: string }>(`/targets/${t.id}/test`);
              toast(res.message, res.ok ? 'success' : 'error');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Test failed', 'error');
            }
          }}
        >
          Test
        </BusyButton>
        <button
          className="btn btn-ghost btn-sm"
          title="Edit"
          onClick={() => open((close) => <TargetEditor backends={backends} target={t} onClose={close} onSaved={reload} />)}
        >
          <Icon name="edit" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title="Duplicate"
          onClick={() => open((close) => <TargetEditor backends={backends} target={t} duplicate onClose={close} onSaved={reload} />)}
        >
          <Icon name="copy" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title="Delete"
          onClick={() =>
            confirmDialog(
              'Delete target',
              `"${t.name}" will be removed. The repository itself stays intact.`,
              async () => {
                await api.del(`/targets/${t.id}`);
                toast('Target deleted', 'success');
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

function BackendFieldInput({
  field: f,
  value,
  onChange,
}: {
  field: BackendField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (f.type === 'textarea') {
    return <textarea name={f.name} placeholder={f.placeholder ?? ''} value={value} onChange={(e) => onChange(e.target.value)} />;
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
  return (
    <input
      name={f.name}
      type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
      placeholder={f.placeholder ?? ''}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function PublicKeyBox({ publicKey }: { publicKey: string }) {
  const toast = useToast();
  return (
    <div>
      <p className="row-sub" style={{ marginBottom: 8 }}>
        Add this public key to the SFTP server (append it to the backup user's{' '}
        <code>~/.ssh/authorized_keys</code>). Then use “Test” to verify the
        connection.
      </p>
      <textarea
        readOnly
        value={publicKey}
        rows={3}
        style={{ fontFamily: 'monospace', fontSize: 12, width: '100%' }}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            const ok = await copyToClipboard(publicKey);
            toast(ok ? 'Public key copied' : 'Copy failed', ok ? 'success' : 'error');
          }}
        >
          <Icon name="copy" /> Copy public key
        </button>
      </div>
    </div>
  );
}

function TargetEditor({
  backends,
  target,
  duplicate = false,
  onClose,
  onSaved,
}: {
  backends: BackendDef[];
  target?: Target;
  duplicate?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  // Duplicate: prefill from an existing target but create a new one (POST).
  // Secret config fields aren't returned by the API, so they start empty and
  // must be re-entered — as does the repository password.
  const isEdit = !!target && !duplicate;
  const isDuplicate = !!target && duplicate;

  const [name, setName] = useState(isDuplicate ? `Copy of ${target!.name}` : target?.name ?? '');
  const [type, setType] = useState(target?.backend_type ?? backends[0].type);
  const [password, setPassword] = useState('');
  // Public key surfaced right after creating an SFTP target so the user can
  // install it on the server before testing.
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const existingPublicKey =
    isEdit && type === 'sftp' ? (target?.config?.publicKey as string | undefined) : undefined;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const cfg = target?.config ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg)) out[k] = v != null ? String(v) : '';
    return out;
  });

  const backend = backends.find((b) => b.type === type)!;
  const setValue = (n: string, v: string) => setValues((cur) => ({ ...cur, [n]: v }));

  const collect = (): Record<string, unknown> => {
    const config: Record<string, unknown> = {};
    for (const f of backend.fields) {
      const v = values[f.name];
      if (v != null && v !== '') config[f.name] = v;
    }
    return config;
  };

  const test = async () => {
    try {
      const res = await api.post<{ ok: boolean; message: string }>('/targets/test', {
        name: name || 'test',
        backendType: type,
        repoPassword: password || 'test',
        config: collect(),
      });
      toast(res.message, res.ok ? 'success' : 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test failed', 'error');
    }
  };

  const submit = async () => {
    try {
      if (isEdit) {
        const payload: Record<string, unknown> = { name, config: collect() };
        if (password) payload.repoPassword = password;
        await api.patch(`/targets/${target!.id}`, payload);
      } else {
        const created = await api.post<Target>('/targets', {
          name,
          backendType: type,
          repoPassword: password,
          config: collect(),
        });
        toast('Target saved', 'success');
        onSaved();
        const pubKey = created?.config?.publicKey as string | undefined;
        if (type === 'sftp' && pubKey) {
          // Keep the modal open to show the generated public key.
          setCreatedKey(pubKey);
          return false;
        }
        return;
      }
      toast('Target saved', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
      return false;
    }
  };

  if (createdKey) {
    return (
      <FormModal
        title="SFTP public key"
        confirmLabel="Done"
        onClose={onClose}
        onSubmit={() => onClose()}
      >
        <PublicKeyBox publicKey={createdKey} />
      </FormModal>
    );
  }

  return (
    <FormModal
      title={isEdit ? 'Edit target' : isDuplicate ? 'Duplicate target' : 'New target'}
      confirmLabel={isEdit ? 'Save' : 'Create'}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name">
        <input type="text" value={name} placeholder="My backup target" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Backend">
        <select name="__type" disabled={isEdit} value={type} onChange={(e) => setType(e.target.value)}>
          {backends.map((b) => (
            <option key={b.type} value={b.type}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={isEdit ? 'Change repository password' : 'Repository password'}>
        <input
          type="password"
          placeholder={isEdit ? '(leave unchanged)' : 'Repository password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {backend.fields.map((f) => (
          <Field key={f.name} label={f.label + (f.required ? ' *' : '')} help={f.help}>
            <BackendFieldInput field={f} value={values[f.name] ?? ''} onChange={(v) => setValue(f.name, v)} />
          </Field>
        ))}
      </div>
      {existingPublicKey && (
        <Field label="SFTP public key">
          <PublicKeyBox publicKey={existingPublicKey} />
        </Field>
      )}
      <div>
        <BusyButton className="btn btn-ghost" onClick={test}>
          Test connection
        </BusyButton>
      </div>
    </FormModal>
  );
}
