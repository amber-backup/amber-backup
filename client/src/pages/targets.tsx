import { useState } from 'react';
import { api, type Target, type BackendDef } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, BusyButton } from '../ui/primitives';
import { BackendFields, PublicKeyBox } from '../ui/backend-fields';
import { useT } from '../i18n';

export function Targets() {
  const { data, loading, reload } = useAsync(() =>
    Promise.all([api.get<Target[]>('/targets'), api.get<BackendDef[]>('/targets/backends')]),
  );
  const { open } = useModal();
  const t = useT();

  if (loading || !data) return <Loading label={t.common.loading} />;
  const [targets, backends] = data;

  const newTarget = () =>
    open((close) => <TargetEditor backends={backends} onClose={close} onSaved={reload} />);

  return (
    <div>
      <PageHeader
        title={t.targets.title}
        subtitle={t.targets.subtitle(targets.length)}
        actions={<ActionButton label={t.targets.newTarget} icon="plus" variant="primary" onClick={newTarget} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{t.targets.panelTitle}</h2>
        </div>
        {targets.length === 0 ? (
          <Empty>{t.targets.empty}</Empty>
        ) : (
          targets.map((tg) => (
            <TargetRow key={tg.id} target={tg} backends={backends} reload={reload} />
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
  const msgs = useT();
  const m = msgs.targets.row;
  const backend = backends.find((b) => b.type === t.backend_type);

  const statusTitle =
    t.status === 'online'
      ? m.reachable
      : t.status === 'offline'
        ? m.offline(t.last_check_error)
        : m.notChecked;

  return (
    <div className="row">
      <span className={`status-dot ${t.status}`} title={statusTitle} />
      <span className="stat-icon" style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}>
        <Icon name="target" size={16} />
      </span>
      <div className="row-main">
        <div className="row-title">{t.name}</div>
        <div className="row-sub">
          {backend?.label ?? t.backend_type}
          {t.status === 'offline' && (
            <span style={{ color: 'var(--danger)' }}>
              {m.offlineInline(t.last_check_error)}
            </span>
          )}
        </div>
      </div>
      <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {t.last_check_at ? m.checked(fmtRelative(t.last_check_at)) : m.notCheckedMeta}
      </div>
      <div className="row-actions">
        <BusyButton
          className="btn btn-ghost btn-sm"
          title={m.checkNow}
          onClick={async () => {
            try {
              const res = await api.post<{ status: Target['status']; error: string | null }>(
                `/targets/${t.id}/check`,
              );
              if (res.status === 'online') toast(m.toastReachable, 'success');
              else if (res.status === 'offline')
                toast(m.toastOffline(res.error), 'error');
              else toast(m.noEndpoint, 'info');
              reload();
            } catch (err) {
              toast(err instanceof Error ? err.message : m.checkFailed, 'error');
            }
          }}
        >
          <Icon name="refresh" />
        </BusyButton>
        <button
          className="btn btn-ghost btn-sm"
          title={m.edit}
          onClick={() => open((close) => <TargetEditor backends={backends} target={t} onClose={close} onSaved={reload} />)}
        >
          <Icon name="edit" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title={m.duplicate}
          onClick={() => open((close) => <TargetEditor backends={backends} target={t} duplicate onClose={close} onSaved={reload} />)}
        >
          <Icon name="copy" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title={msgs.common.delete}
          onClick={() =>
            confirmDialog(
              m.deleteTitle,
              m.deleteConfirm(t.name),
              async () => {
                await api.del(`/targets/${t.id}`);
                toast(m.deleted, 'success');
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
  const t = useT();
  const m = t.targets.editor;
  // A target is now just the shared connection (access + credentials). The
  // repository-specific fields (bucket/path) and the repo password live per job.
  // Duplicate: prefill from an existing target but create a new one (POST).
  // Secret config fields aren't returned by the API, so they start empty and
  // must be re-entered.
  const isEdit = !!target && !duplicate;
  const isDuplicate = !!target && duplicate;

  // The backend catalog only lists connection backends (the local filesystem is
  // a job-level repository option, never a connection), so all of them apply.
  const connections = backends;

  const [name, setName] = useState(isDuplicate ? m.copyOf(target!.name) : target?.name ?? '');
  const [type, setType] = useState(target?.backend_type ?? connections[0].type);
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

  const backend = connections.find((b) => b.type === type)!;
  // Connection editor shows only target-scoped fields; job-scoped repo fields
  // (bucket/prefix/path) are entered per job.
  const connectionFields = backend.fields.filter((f) => f.scope !== 'job');
  const setValue = (n: string, v: string) => setValues((cur) => ({ ...cur, [n]: v }));

  const collect = (): Record<string, unknown> => {
    const config: Record<string, unknown> = {};
    for (const f of connectionFields) {
      const v = values[f.name];
      if (v != null && v !== '') config[f.name] = v;
    }
    return config;
  };

  const submit = async () => {
    try {
      if (isEdit) {
        await api.patch(`/targets/${target!.id}`, { name, config: collect() });
      } else {
        const created = await api.post<Target>('/targets', {
          name,
          backendType: type,
          config: collect(),
        });
        toast(m.saved, 'success');
        onSaved();
        const pubKey = created?.config?.publicKey as string | undefined;
        if (type === 'sftp' && pubKey) {
          // Keep the modal open to show the generated public key.
          setCreatedKey(pubKey);
          return false;
        }
        return;
      }
      toast(m.saved, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : m.saveFailed, 'error');
      return false;
    }
  };

  if (createdKey) {
    return (
      <FormModal
        title={m.publicKey}
        confirmLabel={m.done}
        onClose={onClose}
        onSubmit={() => onClose()}
      >
        <PublicKeyBox publicKey={createdKey} />
      </FormModal>
    );
  }

  return (
    <FormModal
      title={isEdit ? m.titleEdit : isDuplicate ? m.titleDuplicate : m.titleNew}
      confirmLabel={isEdit ? t.common.save : m.create}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={m.name}>
        <input type="text" value={name} placeholder={m.namePlaceholder} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={m.backend}>
        <select name="__type" disabled={isEdit} value={type} onChange={(e) => setType(e.target.value)}>
          {connections.map((b) => (
            <option key={b.type} value={b.type}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <BackendFields fields={connectionFields} values={values} onChange={setValue} />
      </div>
      {existingPublicKey && (
        <Field label={m.publicKey}>
          <PublicKeyBox publicKey={existingPublicKey} />
        </Field>
      )}
    </FormModal>
  );
}
