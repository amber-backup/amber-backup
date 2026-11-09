import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  isWindowsAgent,
  type Agent,
  type BackendDef,
  type HypervHost,
  type HypervHostDetail,
  type HypervVm,
  type HypervVmSnapshot,
  type NotificationChannel,
  type Target,
} from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtRelative, statusLabel } from '../core/format';
import { matchesSearch } from '../core/search';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, ListSearch } from '../ui/primitives';
import { useT } from '../i18n';
import { JobEditor } from './jobs';

/** Inventory updates arrive with the agent's next poll; pages refresh quietly meanwhile. */
const REFRESH_MS = 5000;

const sumDiskBytes = (vm: HypervVm) => vm.disks.reduce((n, d) => n + (d.fileSizeBytes || 0), 0);

// --- Host list ----------------------------------------------------------------

export function Hyperv() {
  const t = useT();
  const m = t.hyperv.page;
  const { data, loading, reload } = useAsync(() =>
    Promise.all([api.get<HypervHost[]>('/hyperv/hosts'), api.get<Agent[]>('/agents')]),
  );
  const { open } = useModal();
  const [query, setQuery] = useState('');

  if (loading || !data) return <Loading label={t.common.loading} />;
  const [hosts, agents] = data;
  const vms = hosts.reduce((n, h) => n + (h.vm_count ?? 0), 0);
  const shown = hosts.filter((h) => matchesSearch(query, [h.name, h.address, h.agent_name]));

  const add = () =>
    open((close) => <HostEditor agents={agents} hosts={hosts} onClose={close} onSaved={reload} />);

  return (
    <div>
      <PageHeader
        title={m.title}
        subtitle={m.subtitle(hosts.length, vms)}
        actions={<ActionButton label={m.addHost} icon="plus" variant="primary" onClick={add} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{m.panelTitle}</h2>
          <ListSearch value={query} onChange={setQuery} />
        </div>
        {hosts.length === 0 ? (
          <Empty>{m.empty}</Empty>
        ) : shown.length === 0 ? (
          <Empty>{t.common.noMatches}</Empty>
        ) : (
          shown.map((h) => (
            <Link key={h.id} to={`/hyperv/${h.id}`} className="row" style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className={`status-dot ${h.agent_status === 'online' ? 'online' : 'offline'}`} />
              <div className="row-main">
                <div className="row-title">{h.name}</div>
                <div className="row-sub">
                  {h.mode === 'remote' ? `${m.modeRemote} · ${h.address}` : m.modeLocal}
                  {' · '}
                  {m.viaAgent} <span style={{ color: 'var(--amber)' }}>{h.agent_name ?? '?'}</span>
                </div>
              </div>
              <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {h.vm_count != null ? m.vmCount(h.vm_count) : m.inventoryPending}
                {h.inventory_at && <> · {fmtRelative(h.inventory_at)}</>}
              </div>
              <Icon name="chevron-right" />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

// --- Host editor --------------------------------------------------------------

function HostEditor({
  host,
  agents,
  hosts,
  onClose,
  onSaved,
}: {
  host?: HypervHost;
  agents: Agent[];
  hosts: HypervHost[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  const m = t.hyperv.editor;
  const toast = useToast();
  const [name, setName] = useState(host?.name ?? '');
  const [mode, setMode] = useState<'local' | 'remote'>(host?.mode ?? 'local');
  // A local host's agent runs on it, so an agent can be the local agent of one host only.
  const takenLocal = new Set(hosts.filter((h) => h.mode === 'local' && h.id !== host?.id).map((h) => h.agent_id));
  const windowsAgents = agents.filter(
    (a) => isWindowsAgent(a) || a.id === host?.agent_id,
  );
  const choices = mode === 'local' ? windowsAgents.filter((a) => !takenLocal.has(a.id)) : windowsAgents;
  const [agentId, setAgentId] = useState(host?.agent_id ?? choices[0]?.id ?? '');
  const [address, setAddress] = useState(host?.address ?? '');
  const [username, setUsername] = useState(host?.username ?? '');
  const [password, setPassword] = useState('');

  const submit = async () => {
    if (!name.trim()) {
      toast(m.nameRequired, 'error');
      return false;
    }
    if (mode === 'remote' && (!address.trim() || !username.trim() || (!host && !password))) {
      toast(m.remoteRequired, 'error');
      return false;
    }
    try {
      let saved: HypervHost;
      if (host) {
        const patch: Record<string, unknown> = { name: name.trim(), agentId };
        if (mode === 'remote') {
          patch.address = address.trim();
          patch.username = username.trim();
          if (password) patch.password = password;
        }
        saved = await api.patch<HypervHost>(`/hyperv/hosts/${host.id}`, patch);
      } else {
        const body: Record<string, unknown> = { name: name.trim(), mode, agentId };
        if (mode === 'remote') Object.assign(body, { address: address.trim(), username: username.trim(), password });
        saved = await api.post<HypervHost>('/hyperv/hosts', body);
      }
      toast(m.saved, 'success');
      onSaved(saved.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : m.saveFailed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={host ? m.titleEdit : m.titleNew} onClose={onClose} onSubmit={submit}>
      <div className="modal-form" style={{ gap: 14 }}>
        <Field label={m.name}>
          <input type="text" value={name} placeholder="hv-01" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={m.mode} help={mode === 'local' ? m.modeHelpLocal : m.modeHelpRemote}>
          <select value={mode} disabled={!!host} onChange={(e) => setMode(e.target.value as 'local' | 'remote')}>
            <option value="local">{m.modeLocal}</option>
            <option value="remote">{m.modeRemote}</option>
          </select>
        </Field>
        <Field label={m.agent} help={choices.length ? (mode === 'local' ? m.agentLocalHelp : m.agentRemoteHelp) : m.noWindowsAgents}>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>{`${a.name} (${statusLabel(a.status)})`}</option>
            ))}
          </select>
        </Field>
        {mode === 'remote' && (
          <>
            <Field label={m.address}>
              <input type="text" value={address} placeholder="hv01.corp.local" onChange={(e) => setAddress(e.target.value)} />
            </Field>
            <Field label={m.username}>
              <input type="text" value={username} placeholder={m.usernamePlaceholder} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label={m.password} help={host ? m.passwordKeep : m.credentialHelp}>
              <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </FormModal>
  );
}

// --- Host detail ----------------------------------------------------------------

export function HypervHostPage() {
  const { hostId } = useParams();
  const t = useT();
  const m = t.hyperv.detail;
  const toast = useToast();
  const navigate = useNavigate();
  const { open, confirmDialog } = useModal();
  const { data, loading, reload } = useAsync(() =>
    Promise.all([
      api.get<HypervHostDetail>(`/hyperv/hosts/${hostId}`),
      api.get<HypervHost[]>('/hyperv/hosts'),
      api.get<Agent[]>('/agents'),
    ]),
  );
  const [live, setLive] = useState<HypervHostDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setLive(null), [data]);

  // While the agent owes an inventory, poll for it quietly.
  const pending = !!(live ?? data?.[0])?.inventory_requested_at;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api.get<HypervHostDetail>(`/hyperv/hosts/${hostId}`).then(setLive).catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending, hostId]);

  const host = live ?? data?.[0];
  const vms = useMemo(
    () => [...(host?.inventory?.vms ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [host],
  );
  if (loading || !data || !host) return <Loading label={t.common.loading} />;
  const [, hosts, agents] = data;
  const protection = new Map(host.protection.map((p) => [p.vmId.toLowerCase(), p]));

  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const refresh = async () => {
    try {
      await api.post(`/hyperv/hosts/${host.id}/refresh`);
      toast(m.refreshRequested, 'success');
      setLive({ ...host, inventory_requested_at: new Date().toISOString() });
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.actionFailed, 'error');
    }
  };

  const backUp = async () => {
    try {
      const [targets, channels, backends] = await Promise.all([
        api.get<Target[]>('/targets'),
        api.get<NotificationChannel[]>('/notification-channels').catch(() => [] as NotificationChannel[]),
        api.get<BackendDef[]>('/targets/backends'),
      ]);
      open((close) => (
        <JobEditor
          targets={targets}
          agents={agents}
          channels={channels}
          backends={backends}
          hypervHosts={hosts}
          preset={{ hostId: host.id, vmIds: [...selected] }}
          onClose={close}
          onSaved={() => {
            setSelected(new Set());
            reload();
          }}
        />
      ));
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.actionFailed, 'error');
    }
  };

  const edit = () =>
    open((close) => <HostEditor host={host} agents={agents} hosts={hosts} onClose={close} onSaved={() => reload()} />);

  const remove = () =>
    confirmDialog(m.remove, m.removeConfirm(host.name), async () => {
      await api.del(`/hyperv/hosts/${host.id}`);
      toast(m.removed, 'success');
      navigate('/hyperv');
    }, true);

  const restore = (vm: HypervVm) =>
    open((close) => <VmRestoreModal vm={vm} host={host} hosts={hosts} onClose={close} />);

  const allSelected = vms.length > 0 && vms.every((v) => selected.has(v.id));

  return (
    <div>
      <PageHeader
        title={host.name}
        subtitle={
          host.inventory
            ? `${host.inventory.computerName} · ${host.inventory.os}`
            : host.mode === 'remote'
              ? host.address ?? ''
              : ''
        }
        actions={
          <>
            <Link to="/hyperv" className="btn btn-ghost">
              <Icon name="arrow-left" />
              {m.back}
            </Link>
            <ActionButton label={m.refresh} icon="refresh" onClick={() => void refresh()} />
            <button className="btn btn-ghost" title={m.edit} onClick={edit}>
              <Icon name="edit" />
            </button>
            <button className="btn btn-ghost" title={m.remove} onClick={remove}>
              <Icon name="trash" />
            </button>
          </>
        }
      />
      {host.inventory_error && (
        <div className="panel" style={{ borderColor: 'var(--red, #c0392b)' }}>
          <div style={{ padding: 14, fontSize: 13 }}>
            <strong>{m.inventoryError}</strong> <span className="mono">{host.inventory_error}</span>
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-head">
          <h2>{m.vms}</h2>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: 'var(--text-2)' }}>
            {host.inventory_at ? m.inventoryAt(fmtDateTime(host.inventory_at)) : m.inventoryPending}
            {vms.length > 0 && (
              <button className="btn btn-primary btn-sm" disabled={selected.size === 0} onClick={() => void backUp()}>
                <Icon name="play" size={14} />
                {m.backUpSelected(selected.size)}
              </button>
            )}
          </div>
        </div>
        {!host.inventory ? (
          <Empty>{m.inventoryPending}</Empty>
        ) : vms.length === 0 ? (
          <Empty>{m.noVms}</Empty>
        ) : (
          <>
            <label className="checkbox" style={{ padding: '8px 16px', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) => setSelected(e.target.checked ? new Set(vms.map((v) => v.id)) : new Set())}
              />
              {m.selectAll}
            </label>
            {vms.map((vm) => (
              <VmRow
                key={vm.id}
                vm={vm}
                protection={protection.get(vm.id.toLowerCase())}
                selected={selected.has(vm.id)}
                onToggle={(on) => toggle(vm.id, on)}
                onRestore={() => restore(vm)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function VmRow({
  vm,
  protection,
  selected,
  onToggle,
  onRestore,
}: {
  vm: HypervVm;
  protection?: HypervHostDetail['protection'][number];
  selected: boolean;
  onToggle: (on: boolean) => void;
  onRestore: () => void;
}) {
  const t = useT();
  const m = t.hyperv.detail;
  const last = protection?.lastBackup ?? null;
  const covered = (protection?.jobs.length ?? 0) > 0;
  const dot = !covered ? 'offline' : last?.status === 'failed' ? 'failed' : 'online';
  // VSS is only known while the guest runs; an off VM checkpoints consistently anyway.
  const vssKnown = vm.state === 'Running';
  return (
    <div className="row">
      <input type="checkbox" checked={selected} onChange={(e) => onToggle(e.target.checked)} aria-label={vm.name} />
      <span className={`status-dot ${dot}`} title={last?.error ?? ''} />
      <div className="row-main">
        <div className="row-title">
          {vm.name} <span className="muted" style={{ fontSize: 12 }}>{vm.state}</span>
        </div>
        <div className="row-sub">
          {m.gen(vm.generation)} · {m.cpu(vm.processorCount)} · {fmtBytes(vm.memoryStartupBytes)} RAM ·{' '}
          {m.disks(vm.disks.length, fmtBytes(sumDiskBytes(vm)))}
          {vssKnown && (
            <>
              {' · '}
              {vm.backupIntegration ? (
                <span style={{ color: 'var(--green, #4caf50)' }}>{m.vssOk}</span>
              ) : (
                <span style={{ color: 'var(--amber)' }} title={m.vssMissingTitle}>{m.vssMissing}</span>
              )}
            </>
          )}
          {vm.staleCheckpoints.length > 0 && (
            <>
              {' · '}
              <span style={{ color: 'var(--amber)' }} title={m.staleTitle}>{m.staleCheckpoints(vm.staleCheckpoints.length)}</span>
            </>
          )}
        </div>
      </div>
      <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)', textAlign: 'right' }}>
        {covered ? (
          <div>
            {m.protectedBy}{' '}
            {protection!.jobs.map((j, i) => (
              <span key={j.id}>
                {i > 0 && ', '}
                <Link to="/jobs" style={{ color: 'var(--amber)' }}>{j.name}</Link>
              </span>
            ))}
          </div>
        ) : (
          <div className="muted">{m.unprotected}</div>
        )}
        {last && (
          <div title={last.error ?? ''}>
            {m.lastBackup} {fmtRelative(last.finishedAt)} · {statusLabel(last.status)}
            {last.consistency === 'crash' && ' · crash'}
          </div>
        )}
      </div>
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" title={m.restore} onClick={onRestore}>
          <Icon name="restore" />
        </button>
      </div>
    </div>
  );
}

// --- Restore ------------------------------------------------------------------

function VmRestoreModal({
  vm,
  host,
  hosts,
  onClose,
}: {
  vm: HypervVm;
  host: HypervHost;
  hosts: HypervHost[];
  onClose: () => void;
}) {
  const t = useT();
  const m = t.hyperv.restore;
  const toast = useToast();
  const { confirmDialog } = useModal();
  const { data: snapshots, loading } = useAsync(() =>
    api.get<HypervVmSnapshot[]>(`/hyperv/vms/${vm.id}/snapshots`),
  );
  const [snapshotKey, setSnapshotKey] = useState('');
  const [action, setAction] = useState<'vm' | 'disks'>('vm');
  const [targetHostId, setTargetHostId] = useState(host.id);
  const defaultPath = vm.configurationLocation.replace(/[\\/][^\\/]+$/, '');
  const [path, setPath] = useState(defaultPath ? `${defaultPath}\\Restore` : '');
  const [newName, setNewName] = useState('');
  const [replace, setReplace] = useState(false);
  const [start, setStart] = useState(false);
  const [connectNetwork, setConnectNetwork] = useState(false);

  const chosen =
    snapshots?.find((s) => `${s.jobId}:${s.snapshot.id}` === snapshotKey) ?? snapshots?.[0];
  const canReplace = action === 'vm' && targetHostId === host.id;

  const send = async () => {
    await api.post('/restores', {
      jobId: chosen!.jobId,
      snapshotId: chosen!.snapshot.id,
      mode: 'hyperv',
      destination: {
        path: path.trim(),
        hyperv: {
          hostId: targetHostId,
          vmId: vm.id,
          action,
          newName: newName.trim() || undefined,
          replaceOriginal: canReplace && replace,
          start: action === 'vm' && start,
          connectNetwork: action === 'vm' && connectNetwork,
        },
      },
    });
    toast(m.started, 'success');
  };

  const submit = async () => {
    if (!chosen) return false;
    if (!path.trim()) {
      toast(m.targetPathRequired, 'error');
      return false;
    }
    try {
      if (canReplace && replace) {
        // A second, explicit confirmation before the original goes away.
        confirmDialog(m.replaceConfirmTitle, m.replaceConfirm(vm.name), async () => {
          try {
            await send();
          } catch (err) {
            toast(err instanceof Error ? err.message : m.failed, 'error');
          }
        }, true);
        return;
      }
      await send();
    } catch (err) {
      toast(err instanceof Error ? err.message : m.failed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={m.title(vm.name)} wide confirmLabel={m.action} onClose={onClose} onSubmit={submit}>
      {loading || !snapshots ? (
        <Loading label={m.loading} />
      ) : snapshots.length === 0 ? (
        <Empty>{m.noSnapshots}</Empty>
      ) : (
        <div className="modal-form" style={{ gap: 14 }}>
          <Field label={m.snapshot}>
            <select value={snapshotKey || `${chosen!.jobId}:${chosen!.snapshot.id}`} onChange={(e) => setSnapshotKey(e.target.value)}>
              {snapshots.map((s) => (
                <option key={`${s.jobId}:${s.snapshot.id}`} value={`${s.jobId}:${s.snapshot.id}`}>
                  {m.snapshotOption(fmtDateTime(s.snapshot.time), s.jobName, s.snapshot.hostname)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={m.action}>
            <select value={action} onChange={(e) => setAction(e.target.value as 'vm' | 'disks')}>
              <option value="vm">{m.actionVm}</option>
              <option value="disks">{m.actionDisks}</option>
            </select>
          </Field>
          <Field label={m.targetHost}>
            <select value={targetHostId} onChange={(e) => setTargetHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </Field>
          <Field label={m.targetPath} help={m.targetPathHelp}>
            <input type="text" value={path} placeholder="D:\Hyper-V\Restore" onChange={(e) => setPath(e.target.value)} />
          </Field>
          <Field label={m.newName}>
            <input
              type="text"
              value={newName}
              placeholder={replace && canReplace ? vm.name : m.newNamePlaceholder(vm.name)}
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          {action === 'vm' && (
            <>
              {canReplace && (
                <Field label="" help={m.replaceHelp}>
                  <label className="checkbox">
                    <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                    {m.replace}
                  </label>
                </Field>
              )}
              <Field label="" help={m.connectNetworkHelp}>
                <label className="checkbox">
                  <input type="checkbox" checked={connectNetwork} onChange={(e) => setConnectNetwork(e.target.checked)} />
                  {m.connectNetwork}
                </label>
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
                {m.start}
              </label>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{m.note}</div>
            </>
          )}
        </div>
      )}
    </FormModal>
  );
}
