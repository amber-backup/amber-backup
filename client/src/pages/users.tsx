import { useState } from 'react';
import { api, type User, type Target, type Job } from '../core/api';
import { Icon } from '../core/icons';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal, ModalFrame } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading } from '../ui/primitives';
import { useT } from '../i18n';

interface Grant {
  id: string;
  resource_type: string;
  resource_id: string;
  access_level: string;
}

export function Users() {
  const t = useT();
  const { data, loading, reload } = useAsync(() => api.get<User[]>('/users'));
  const { open } = useModal();

  if (loading || !data) return <Loading label={t.common.loading} />;
  const users = data;

  const newUser = () => open((close) => <CreateUser onClose={close} onSaved={reload} />);

  return (
    <div>
      <PageHeader
        title={t.users.title}
        subtitle={t.users.accounts(users.length)}
        actions={<ActionButton label={t.users.newUser} icon="plus" variant="primary" onClick={newUser} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{t.users.title}</h2>
        </div>
        {users.map((u) => (
          <UserRow key={u.id} user={u} reload={reload} />
        ))}
      </div>
    </div>
  );
}

function UserRow({ user: u, reload }: { user: User; reload: () => void }) {
  const t = useT();
  const toast = useToast();
  const { open, confirmDialog } = useModal();

  const statusBadge = u.disabled ? (
    <span className="badge danger">{u.auth_source !== 'local' ? t.users.badge.ssoApprovalNeeded : t.users.badge.disabled}</span>
  ) : u.is_admin ? (
    <span className="badge warn">{t.common.administrator}</span>
  ) : (
    <span className="badge success">{t.users.badge.active}</span>
  );

  return (
    <div className="row">
      <span className="stat-icon" style={{ background: 'var(--bg-3)', color: 'var(--text-2)' }}>
        <Icon name="users" size={16} />
      </span>
      <div className="row-main">
        <div className="row-title">{u.display_name}</div>
        <div className="row-sub">{`${u.email} · ${u.auth_source}`}</div>
      </div>
      {statusBadge}
      <div className="row-actions">
        {u.disabled && (
          <button
            className="btn btn-primary btn-sm"
            onClick={async () => {
              await api.post(`/users/${u.id}/enable`);
              toast(t.users.enabledToast, 'success');
              reload();
            }}
          >
            <Icon name="check" />
            {t.users.enable}
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          title={t.users.grants}
          onClick={() => open((close) => <GrantsModal user={u} onClose={close} />)}
        >
          <Icon name="key" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => open((close) => <EditUser user={u} onClose={close} onSaved={reload} />)}
        >
          <Icon name="edit" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() =>
            confirmDialog(
              t.users.deleteTitle,
              t.users.deleteConfirm(u.display_name),
              async () => {
                await api.del(`/users/${u.id}`);
                toast(t.users.deleted, 'success');
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

function CreateUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(false);

  const submit = async () => {
    try {
      await api.post('/users', { email, displayName: name, password, isAdmin: admin });
      toast(t.users.created, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.error, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.users.newUser} confirmLabel={t.users.create} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={t.users.email}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t.users.displayName}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t.users.password}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          {t.common.administrator}
        </label>
      </div>
    </FormModal>
  );
}

function EditUser({ user: u, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const wasLocal = u.auth_source === 'local';
  const [name, setName] = useState(u.display_name);
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(u.is_admin);
  const [disabled, setDisabled] = useState(u.disabled);
  const [local, setLocal] = useState(wasLocal);

  const submit = async () => {
    const payload: Record<string, unknown> = { displayName: name, isAdmin: admin, disabled };
    if (local !== wasLocal) payload.authSource = local ? 'local' : 'sso';
    if (password) payload.password = password;
    try {
      await api.patch(`/users/${u.id}`, payload);
      toast(t.users.saved, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.error, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.users.editUser} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={t.users.displayName}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t.users.signInMethod}>
          <select value={local ? 'local' : 'sso'} onChange={(e) => setLocal(e.target.value === 'local')}>
            <option value="local">{t.users.localPassword}</option>
            <option value="sso">{t.users.ssoOnly}</option>
          </select>
        </Field>
        {local && (
          <Field label={wasLocal ? t.users.newPassword : t.users.password}>
            <input
              type="password"
              placeholder={wasLocal ? t.users.unchanged : t.users.passwordRequired}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {wasLocal && !local && (
          <div className="help">{t.users.switchToSsoHelp}</div>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          {t.common.administrator}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
          {t.users.disabled}
        </label>
      </div>
    </FormModal>
  );
}

function GrantsModal({ user: u, onClose }: { user: User; onClose: () => void }) {
  const t = useT();
  const { data, loading, reload } = useAsync(() =>
    Promise.all([
      api.get<Grant[]>(`/users/${u.id}/grants`),
      api.get<Target[]>('/targets'),
      api.get<Job[]>('/jobs'),
    ]),
  );

  return (
    <ModalFrame
      title={t.users.grantsTitle(u.display_name)}
      wide
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          {t.common.close}
        </button>
      }
    >
      {loading || !data ? (
        <Loading label={t.common.loading} />
      ) : (
        <GrantsBody user={u} grants={data[0]} targets={data[1]} jobs={data[2]} reload={reload} />
      )}
    </ModalFrame>
  );
}

function GrantsBody({
  user: u,
  grants,
  targets,
  jobs,
  reload,
}: {
  user: User;
  grants: Grant[];
  targets: Target[];
  jobs: Job[];
  reload: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [type, setType] = useState<'target' | 'job'>('target');
  const [resourceId, setResourceId] = useState(targets[0]?.id ?? '');
  const [level, setLevel] = useState('view');

  const pool = type === 'target' ? targets : jobs;

  const resourceName = (rt: string, id: string): string => {
    const p = rt === 'target' ? targets : jobs;
    return p.find((r) => r.id === id)?.name ?? id.slice(0, 8);
  };

  const changeType = (v: 'target' | 'job') => {
    setType(v);
    const next = v === 'target' ? targets : jobs;
    setResourceId(next[0]?.id ?? '');
  };

  const addGrant = async () => {
    try {
      await api.post(`/users/${u.id}/grants`, {
        resourceType: type,
        resourceId,
        accessLevel: level,
      });
      reload();
      toast(t.users.grantAdded, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.error, 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        {grants.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            {t.users.noGrants}
          </div>
        ) : (
          grants.map((g) => (
            <div className="row" style={{ padding: '10px 0' }} key={g.id}>
              <div className="row-main">
                <div className="row-title">{`${t.users.resourceTypes[g.resource_type] ?? g.resource_type}: ${resourceName(g.resource_type, g.resource_id)}`}</div>
                <div className="row-sub">{t.users.levels[g.access_level] ?? g.access_level}</div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await api.del(`/users/${u.id}/grants/${g.id}`);
                  reload();
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))
        )}
      </div>
      <div
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div className="field-row">
          <Field label={t.users.type}>
            <select value={type} onChange={(e) => changeType(e.target.value as 'target' | 'job')}>
              <option value="target">{t.users.resourceTypes.target}</option>
              <option value="job">{t.users.resourceTypes.job}</option>
            </select>
          </Field>
          <Field label={t.users.resource}>
            <select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              {pool.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t.users.access}>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="view">{t.users.levelView}</option>
            <option value="operate">{t.users.levelOperate}</option>
            <option value="manage">{t.users.levelManage}</option>
          </select>
        </Field>
        <div>
          <button className="btn btn-ghost" onClick={addGrant}>
            <Icon name="plus" />
            {t.users.addGrant}
          </button>
        </div>
      </div>
    </div>
  );
}
