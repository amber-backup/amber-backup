import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  proxmoxApi,
  proxmoxSnapshotMethod,
  type Agent,
  type BackendDef,
  type HypervHost,
  type NotificationChannel,
  type ProxmoxCandidate,
  type ProxmoxCluster,
  type ProxmoxClusterDetail,
  type ProxmoxGuest,
  type ProxmoxGuestProtection,
  type ProxmoxGuestSnapshot,
  type ProxmoxRestoreSpec,
  type ProxmoxSummary,
  type Target,
} from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtRelative, statusLabel } from '../core/format';
import { matchesSearch } from '../core/search';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal, ModalFrame } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, ListSearch } from '../ui/primitives';
import { useT } from '../i18n';
import { JobEditor } from './jobs';
import { methodLabel, ProxmoxRunItemsList } from '../ui/proxmox-run-items';

/** Inventory updates arrive with the agent's next poll; pages refresh quietly meanwhile. */
const REFRESH_MS = 5000;

const diskBytes = (g: ProxmoxGuest) => g.disks.reduce((n, d) => n + (d.sizeBytes || 0), 0);

// --- Cluster list ---------------------------------------------------------------

export function Proxmox() {
  const t = useT();
  const m = t.proxmox.page;
  const { data, loading, reload } = useAsync(() =>
    Promise.all([proxmoxApi.clusters(), proxmoxApi.candidates().catch(() => [] as ProxmoxCandidate[])]),
  );
  const { open } = useModal();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  if (loading || !data) return <Loading label={t.common.loading} />;
  const [clusters, candidates] = data;
  const guests = clusters.reduce((n, c) => n + (c.guest_count ?? 0), 0);
  const shown = clusters.filter((c) => matchesSearch(query, [c.name, c.cluster_name, c.agent_name]));

  const add = () =>
    open((close) => (
      <ClusterEditor
        candidates={candidates}
        onClose={close}
        onSaved={(id) => {
          reload();
          navigate(`/proxmox/${id}`);
        }}
      />
    ));

  return (
    <div>
      <PageHeader
        title={m.title}
        subtitle={m.subtitle(clusters.length, guests)}
        actions={<ActionButton label={m.addCluster} icon="plus" variant="primary" onClick={add} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{m.panelTitle}</h2>
          <ListSearch value={query} onChange={setQuery} />
        </div>
        {clusters.length === 0 ? (
          <Empty>{m.empty}</Empty>
        ) : shown.length === 0 ? (
          <Empty>{t.common.noMatches}</Empty>
        ) : (
          shown.map((c) => (
            <Link key={c.id} to={`/proxmox/${c.id}`} className="row" style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className={`status-dot ${c.agent_status === 'online' ? 'online' : 'offline'}`} />
              <div className="row-main">
                <div className="row-title">{c.name}</div>
                <div className="row-sub">
                  {c.cluster_name ?? m.standalone}
                  {' · '}
                  {m.primary} <span className="ref">{c.agent_name ?? '?'}</span>
                </div>
              </div>
              <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {c.guest_count != null ? (
                  <>
                    {m.nodeCount(c.node_count ?? 0)} · {m.guestCount(c.guest_count)}
                  </>
                ) : (
                  m.inventoryPending
                )}
                {c.inventory_at && <> · {fmtRelative(c.inventory_at)}</>}
              </div>
              <Icon name="chevron-right" />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

// --- Cluster editor -----------------------------------------------------------------

function ClusterEditor({
  cluster,
  candidates,
  onClose,
  onSaved,
}: {
  cluster?: ProxmoxCluster;
  candidates: ProxmoxCandidate[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  const m = t.proxmox.editor;
  const toast = useToast();
  // New: any agent on a node of a cluster Amber doesn't know yet. Edit: the
  // agents on this cluster's nodes.
  const choices = cluster
    ? candidates.filter((c) => c.info.clusterId === cluster.pve_cluster_id)
    : candidates.filter((c) => !c.registeredClusterId);
  const [agentId, setAgentId] = useState(cluster?.primary_agent_id ?? choices[0]?.agentId ?? '');
  const chosen = choices.find((c) => c.agentId === agentId);
  const [name, setName] = useState(cluster?.name ?? '');
  const defaultName = chosen ? (chosen.info.clusterName ?? chosen.info.node) : '';

  const submit = async () => {
    const finalName = (name.trim() || defaultName).trim();
    if (!finalName) {
      toast(m.nameRequired, 'error');
      return false;
    }
    if (!agentId) {
      toast(m.agentRequired, 'error');
      return false;
    }
    try {
      const saved = cluster
        ? await proxmoxApi.update(cluster.id, {
            name: finalName,
            ...(agentId !== cluster.primary_agent_id ? { primaryAgentId: agentId } : {}),
          })
        : await proxmoxApi.create({ name: finalName, primaryAgentId: agentId });
      toast(m.saved, 'success');
      onSaved(saved.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : m.saveFailed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={cluster ? m.titleEdit : m.titleNew} onClose={onClose} onSubmit={submit}>
      <div className="modal-form" style={{ gap: 14 }}>
        <Field
          label={cluster ? m.primaryAgent : m.agent}
          help={choices.length ? (cluster ? m.primaryHelp : m.agentHelp) : m.noCandidates}
        >
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {cluster && !choices.some((c) => c.agentId === cluster.primary_agent_id) && (
              <option value={cluster.primary_agent_id}>{cluster.agent_name ?? cluster.primary_agent_id}</option>
            )}
            {choices.map((c) => (
              <option key={c.agentId} value={c.agentId}>
                {`${m.candidateOption(c.agentName, c.info.node, c.info.clusterName)} · ${statusLabel(c.agentStatus)}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label={m.name}>
          <input
            type="text"
            value={name}
            placeholder={defaultName || 'pve-cluster'}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
    </FormModal>
  );
}

// --- Cluster detail -----------------------------------------------------------------

export function ProxmoxClusterPage() {
  const { clusterId } = useParams();
  const t = useT();
  const m = t.proxmox.detail;
  const toast = useToast();
  const navigate = useNavigate();
  const { open, confirmDialog } = useModal();
  const { data, loading, reload } = useAsync(() =>
    Promise.all([
      proxmoxApi.cluster(clusterId!),
      proxmoxApi.clusters(),
      proxmoxApi.candidates().catch(() => [] as ProxmoxCandidate[]),
      api.get<Agent[]>('/agents'),
    ]),
  );
  const [live, setLive] = useState<ProxmoxClusterDetail | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  useEffect(() => setLive(null), [data]);

  // While the agent owes an inventory, poll for it quietly.
  const pending = !!(live ?? data?.[0])?.inventory_requested_at;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      proxmoxApi.cluster(clusterId!).then(setLive).catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending, clusterId]);

  const cluster = live ?? data?.[0];
  const guests = useMemo(
    () => [...(cluster?.inventory?.guests ?? [])].sort((a, b) => a.vmid - b.vmid),
    [cluster],
  );
  if (loading || !data || !cluster) return <Loading label={t.common.loading} />;
  const [, clusters, candidates, agents] = data;
  const protection = new Map(cluster.protection.map((p) => [p.vmid, p]));
  const shown = guests.filter((g) =>
    matchesSearch(query, [g.name, String(g.vmid), g.node, g.pool, ...g.tags]),
  );

  const toggle = (vmid: number, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(vmid);
      else next.delete(vmid);
      return next;
    });

  const refresh = async () => {
    try {
      await proxmoxApi.refresh(cluster.id);
      toast(m.refreshRequested, 'success');
      setLive({ ...cluster, inventory_requested_at: new Date().toISOString() });
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.actionFailed, 'error');
    }
  };

  const backUp = async () => {
    try {
      const [targets, channels, backends, hypervHosts] = await Promise.all([
        api.get<Target[]>('/targets'),
        api.get<NotificationChannel[]>('/notification-channels').catch(() => [] as NotificationChannel[]),
        api.get<BackendDef[]>('/targets/backends'),
        api.get<HypervHost[]>('/hyperv/hosts').catch(() => [] as HypervHost[]),
      ]);
      open((close) => (
        <JobEditor
          targets={targets}
          agents={agents}
          channels={channels}
          backends={backends}
          hypervHosts={hypervHosts}
          proxmoxClusters={clusters}
          proxmoxPreset={{ clusterId: cluster.id, vmids: [...selected] }}
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
    open((close) => (
      <ClusterEditor cluster={cluster} candidates={candidates} onClose={close} onSaved={() => reload()} />
    ));

  const remove = () =>
    confirmDialog(m.remove, m.removeConfirm(cluster.name), async () => {
      await proxmoxApi.remove(cluster.id);
      toast(m.removed, 'success');
      navigate('/proxmox');
    }, true, { confirmLabel: m.remove });

  const restore = (guest: ProxmoxGuest) =>
    open((close) => <GuestRestoreModal guest={guest} cluster={cluster} onClose={close} />);

  const allSelected = shown.length > 0 && shown.every((g) => selected.has(g.vmid));
  const inv = cluster.inventory;

  return (
    <div>
      <PageHeader
        title={cluster.name}
        subtitle={[cluster.cluster_name ?? t.proxmox.page.standalone, inv?.pveVersion].filter(Boolean).join(' · ')}
        actions={
          <>
            <Link to="/proxmox" className="btn btn-ghost">
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
      {cluster.inventory_error && (
        <div className="panel" style={{ borderColor: 'var(--red, #c0392b)' }}>
          <div style={{ padding: 14, fontSize: 13 }}>
            <strong>{m.inventoryError}</strong> <span className="mono">{cluster.inventory_error}</span>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>{m.nodes}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {cluster.inventory_at ? m.inventoryAt(fmtDateTime(cluster.inventory_at)) : m.inventoryPending}
          </div>
        </div>
        {cluster.nodes.length === 0 ? (
          <Empty>{m.inventoryPending}</Empty>
        ) : (
          cluster.nodes.map((n) => {
            const guestsOn = guests.filter((g) => g.node === n.name).length;
            const dot = !n.agentId ? 'failed' : n.agentStatus === 'online' ? 'online' : 'offline';
            return (
              <div key={n.name} className="row">
                <span className={`status-dot ${dot}`} />
                <div className="row-main">
                  <div className="row-title">
                    {n.name}{' '}
                    <span className="muted" style={{ fontSize: 12 }}>{n.online ? m.nodeOnline : m.nodeOffline}</span>
                    {n.agentId === cluster.primary_agent_id && (
                      <span className="badge muted row-kind">{m.primaryBadge}</span>
                    )}
                  </div>
                  <div className="row-sub">
                    {n.agentId ? (
                      <>
                        {m.agentLabel} <span className="ref">{n.agentName ?? '?'}</span>
                        {' · '}
                        {statusLabel(n.agentStatus ?? 'offline')}
                      </>
                    ) : (
                      <span className={guestsOn ? 'danger-text' : 'warn-text'}><Icon name="alert" size={12} />{m.noAgent}</span>
                    )}
                  </div>
                </div>
                <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  {t.proxmox.page.guestCount(guestsOn)}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{m.guests}</h2>
          <div className="panel-head-actions">
            <ListSearch value={query} onChange={setQuery} />
            {guests.length > 0 && (
              <button className="btn btn-primary btn-sm" disabled={selected.size === 0} onClick={() => void backUp()}>
                <Icon name="play" size={14} />
                {m.backUpSelected(selected.size)}
              </button>
            )}
          </div>
        </div>
        {!inv ? (
          <Empty>{m.inventoryPending}</Empty>
        ) : guests.length === 0 ? (
          <Empty>{m.noGuests}</Empty>
        ) : shown.length === 0 ? (
          <Empty>{t.common.noMatches}</Empty>
        ) : (
          <>
            <label className="checkbox" style={{ padding: '8px 16px', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) =>
                  setSelected((cur) => {
                    const next = new Set(cur);
                    for (const g of shown) {
                      if (e.target.checked) next.add(g.vmid);
                      else next.delete(g.vmid);
                    }
                    return next;
                  })
                }
              />
              {m.selectAll}
            </label>
            {shown.map((g) => (
              <GuestRow
                key={g.vmid}
                guest={g}
                protection={protection.get(g.vmid)}
                selected={selected.has(g.vmid)}
                onToggle={(on) => toggle(g.vmid, on)}
                onRestore={() => restore(g)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function GuestRow({
  guest: g,
  protection,
  selected,
  onToggle,
  onRestore,
}: {
  guest: ProxmoxGuest;
  protection?: ProxmoxGuestProtection;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onRestore: () => void;
}) {
  const t = useT();
  const m = t.proxmox.detail;
  const last = protection?.lastBackup ?? null;
  const covered = (protection?.jobs.length ?? 0) > 0;
  const dot = !covered ? 'offline' : last?.status === 'failed' ? 'failed' : 'online';
  const warn = (text: string, title?: string) => (
    <>
      {' · '}
      <span className="warn-text" title={title}><Icon name="alert" size={12} />{text}</span>
    </>
  );
  return (
    <div className="row">
      <input type="checkbox" checked={selected} onChange={(e) => onToggle(e.target.checked)} aria-label={g.name} />
      <span className={`status-dot ${dot}`} title={last?.error ?? ''} />
      <div className="row-main">
        <div className="row-title">
          <span className="badge muted" style={{ marginRight: 6 }}>{g.type === 'qemu' ? m.typeVm : m.typeCt}</span>
          {g.vmid} · {g.name}{' '}
          <span className="muted" style={{ fontSize: 12 }}>
            {g.status} · {g.node}
            {g.template && ` · ${m.template}`}
          </span>
        </div>
        <div className="row-sub">
          {g.cores != null && <>{m.cores(g.cores)} · </>}
          {g.memoryBytes != null && <>{fmtBytes(g.memoryBytes)} RAM · </>}
          {m.disks(g.disks.length, fmtBytes(diskBytes(g)))}
          {' · '}
          {m.method}{' '}
          <span className={g.autoMethod === 'vzdump' ? 'warn-text' : undefined} title={g.autoMethodReason ?? ''}>
            {g.autoMethod === 'vzdump' && <Icon name="alert" size={12} />}
            {methodLabel(t, g.autoMethod)}
          </span>
          {g.type === 'qemu' && g.status === 'running' && g.guestAgent === false && warn(m.noGuestAgent, m.noGuestAgentTitle)}
          {g.type === 'lxc' && g.unprivileged && <> · {m.unprivileged}</>}
          {g.lock && warn(m.lock(g.lock))}
          {g.haState && <> · {m.ha(g.haState)}</>}
          {g.pool && <> · {g.pool}</>}
          {g.staleSnapshots.length > 0 && warn(m.staleSnapshots(g.staleSnapshots.length), m.staleTitle)}
        </div>
      </div>
      <div className="row-meta pve-guest-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {covered ? (
          <div>
            {m.protectedBy}{' '}
            {protection!.jobs.map((j, i) => (
              <span key={j.id}>
                {i > 0 && ', '}
                <Link to="/jobs" className="ref-link">{j.name}</Link>
              </span>
            ))}
          </div>
        ) : (
          <div className="muted">{m.unprotected}</div>
        )}
        {last && (
          <div title={last.error ?? last.cbtReason ?? ''}>
            {m.lastBackup} {fmtRelative(last.finishedAt)} · {statusLabel(last.status)}
            {last.cbt && ` · ${t.proxmox.cbt[last.cbt]}`}
            {last.consistency === 'crash' && ` · ${t.proxmox.consistency.crash}`}
          </div>
        )}
      </div>
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" title={m.restore} aria-label={m.restore} onClick={onRestore}>
          <Icon name="restore" />
          <span className="btn-label">{m.restore}</span>
        </button>
      </div>
    </div>
  );
}

// --- Restore ------------------------------------------------------------------------

function GuestRestoreModal({
  guest,
  cluster,
  onClose,
}: {
  guest: ProxmoxGuest;
  cluster: ProxmoxClusterDetail;
  onClose: () => void;
}) {
  const t = useT();
  const m = t.proxmox.restore;
  const toast = useToast();
  const { confirm } = useModal();
  const { data: snapshots, loading } = useAsync(() => proxmoxApi.guestSnapshots(cluster.id, guest.vmid));
  const [snapshotKey, setSnapshotKey] = useState('');
  const chosen: ProxmoxGuestSnapshot | undefined =
    snapshots?.find((s) => `${s.jobId}:${s.snapshot.id}` === snapshotKey) ?? snapshots?.[0];
  const method = proxmoxSnapshotMethod(chosen?.snapshot);
  const filesPossible = guest.type === 'lxc' && method === 'files';
  // File restores out of VMs and live restores read the block method's disk images.
  const blockVm = guest.type === 'qemu' && method === 'block';

  const agentNodes = cluster.nodes.filter((n) => n.agentId);
  const [action, setAction] = useState<'guest' | 'files' | 'vm-files'>('guest');
  const effectiveAction =
    action === 'files' && filesPossible ? 'files' : action === 'vm-files' && blockVm ? 'vm-files' : 'guest';
  const [targetNode, setTargetNode] = useState(
    agentNodes.find((n) => n.name === guest.node)?.name ?? agentNodes[0]?.name ?? '',
  );
  const [newVmid, setNewVmid] = useState('');
  const [replace, setReplace] = useState(false);
  const [storage, setStorage] = useState('');
  const [unique, setUnique] = useState(true);
  const [name, setName] = useState('');
  const [start, setStart] = useState(false);
  const [bwlimit, setBwlimit] = useState('');
  const containers = (cluster.inventory?.guests ?? []).filter((g) => g.type === 'lxc');
  const [targetVmid, setTargetVmid] = useState<number>(guest.vmid);
  const [paths, setPaths] = useState('');
  const [targetPath, setTargetPath] = useState('/var/tmp/amber-restore');
  const [live, setLive] = useState(false);
  const [overlayStorage, setOverlayStorage] = useState('');
  const liveRestore = effectiveAction === 'guest' && blockVm && live && !replace;
  const replaceActive = effectiveAction === 'guest' && replace;

  // Storages that hold this guest type's disks and exist on the target node.
  const content = guest.type === 'qemu' ? 'images' : 'rootdir';
  const storages = (cluster.inventory?.storages ?? []).filter(
    (s) => s.content.includes(content) && (s.nodes.length === 0 || s.nodes.includes(targetNode)),
  );
  // Overlays of a live restore are qcow2 files: dir-like storages only.
  const overlayStorages = storages.filter((s) => ['dir', 'nfs', 'cifs', 'glusterfs'].includes(s.type));
  const overlayChoice = overlayStorage || overlayStorages[0]?.id || '';

  const send = async () => {
    const spec: ProxmoxRestoreSpec = {
      clusterId: cluster.id,
      vmid: guest.vmid,
      guestType: guest.type,
      action: effectiveAction,
      targetNode,
    };
    if (effectiveAction === 'guest') {
      if (replace) spec.replaceOriginal = true;
      else if (newVmid.trim()) spec.newVmid = Number(newVmid);
      if (storage) spec.storage = storage;
      spec.unique = !replace && unique;
      if (name.trim()) spec.name = name.trim();
      spec.start = liveRestore || start;
      if (bwlimit.trim()) spec.bwlimitKiB = Number(bwlimit);
      if (liveRestore) {
        spec.liveRestore = true;
        spec.overlayStorage = overlayChoice;
      }
    } else if (effectiveAction === 'vm-files') {
      spec.targetPath = targetPath.trim();
    } else {
      spec.targetVmid = targetVmid;
    }
    const includedPaths =
      effectiveAction !== 'guest'
        ? paths.split('\n').map((p) => p.trim()).filter(Boolean)
        : [];
    await api.post('/restores', {
      jobId: chosen!.jobId,
      snapshotId: chosen!.snapshot.id,
      mode: 'proxmox',
      ...(includedPaths.length ? { includedPaths } : {}),
      destination: { proxmox: spec },
    });
    toast(m.started, 'success');
  };

  const submit = async () => {
    if (!chosen) return false;
    if (!targetNode) {
      toast(m.nodeRequired, 'error');
      return false;
    }
    if (effectiveAction === 'vm-files') {
      const tp = targetPath.trim().replace(/\/+$/, '');
      if (!tp.startsWith('/') || tp.split('/').includes('..')) {
        toast(m.targetPathRequired, 'error');
        return false;
      }
    }
    if (liveRestore && !overlayChoice) {
      toast(m.overlayRequired, 'error');
      return false;
    }
    // A second, explicit confirmation before the original is overwritten. The
    // restore dialog stays open behind it: cancelling returns to the filled-in
    // form, and only a started restore closes it.
    if (
      replaceActive &&
      !(await confirm({
        title: m.replaceConfirmTitle,
        message: m.replaceConfirm(guest.name, guest.vmid, fmtDateTime(chosen.snapshot.time), targetNode),
        confirmLabel: m.replaceConfirmAction,
        danger: true,
      }))
    ) {
      return false;
    }
    try {
      await send();
    } catch (err) {
      toast(err instanceof Error ? err.message : m.failed, 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={m.title(`${guest.vmid} · ${guest.name}`)}
      wide
      confirmLabel={replaceActive ? m.replaceAction : m.action}
      danger={replaceActive}
      onClose={onClose}
      onSubmit={submit}
    >
      {loading || !snapshots ? (
        <Loading label={m.loading} />
      ) : snapshots.length === 0 ? (
        <Empty>{m.noSnapshots}</Empty>
      ) : (
        <div className="modal-form" style={{ gap: 14 }}>
          <Field label={m.snapshot}>
            <select
              value={snapshotKey || `${chosen!.jobId}:${chosen!.snapshot.id}`}
              onChange={(e) => setSnapshotKey(e.target.value)}
            >
              {snapshots.map((s) => (
                <option key={`${s.jobId}:${s.snapshot.id}`} value={`${s.jobId}:${s.snapshot.id}`}>
                  {m.snapshotOption(
                    fmtDateTime(s.snapshot.time),
                    s.jobName,
                    methodLabel(t, proxmoxSnapshotMethod(s.snapshot)),
                  )}
                </option>
              ))}
            </select>
          </Field>
          {guest.type === 'lxc' ? (
            <Field label={m.action} help={filesPossible ? undefined : m.filesOnlyNote}>
              <select value={effectiveAction} onChange={(e) => setAction(e.target.value as 'guest' | 'files')}>
                <option value="guest">{m.actionGuest}</option>
                <option value="files" disabled={!filesPossible}>{m.actionFiles}</option>
              </select>
            </Field>
          ) : (
            <Field label={m.action} help={blockVm ? undefined : m.vmFilesOnlyNote}>
              <select value={effectiveAction} onChange={(e) => setAction(e.target.value as 'guest' | 'vm-files')}>
                <option value="guest">{m.actionGuest}</option>
                <option value="vm-files" disabled={!blockVm}>{m.actionVmFiles}</option>
              </select>
            </Field>
          )}
          <Field label={m.targetNode} help={agentNodes.length ? m.targetNodeHelp : m.noAgentNodes}>
            <select value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
              {agentNodes.map((n) => (
                <option key={n.name} value={n.name}>
                  {`${n.name} (${n.agentName ?? '?'} · ${statusLabel(n.agentStatus ?? 'offline')})`}
                </option>
              ))}
            </select>
          </Field>
          {effectiveAction === 'guest' ? (
            <>
              <Field label="" help={replace ? undefined : m.replaceHelp}>
                <label className="checkbox">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                  {m.replace}
                </label>
              </Field>
              {replace && (
                <div className="warn-box" role="alert">
                  {m.replaceHelp}
                </div>
              )}
              {blockVm && !replace && (
                <Field label="" help={m.liveHelp}>
                  <label className="checkbox">
                    <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
                    {m.live}
                  </label>
                </Field>
              )}
              {liveRestore && (
                <Field label={m.overlayStorage} help={overlayStorages.length ? m.overlayStorageHelp : m.noOverlayStorage}>
                  <select value={overlayChoice} onChange={(e) => setOverlayStorage(e.target.value)}>
                    {overlayStorages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {`${s.id} (${s.type}${s.availBytes != null ? ` · ${fmtBytes(s.availBytes)}` : ''})`}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {!replace && (
                <Field label={m.newVmid} help={m.newVmidHelp}>
                  <input type="number" min="100" value={newVmid} placeholder="—" onChange={(e) => setNewVmid(e.target.value)} />
                </Field>
              )}
              <Field label={m.storage}>
                <select value={storage} onChange={(e) => setStorage(e.target.value)}>
                  <option value="">{m.storageOriginal}</option>
                  {storages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {`${s.id} (${s.type}${s.availBytes != null ? ` · ${fmtBytes(s.availBytes)}` : ''})`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={m.name}>
                <input type="text" value={name} placeholder={m.namePlaceholder(guest.name)} onChange={(e) => setName(e.target.value)} />
              </Field>
              {!replace && (
                <label className="checkbox">
                  <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
                  {m.unique}
                </label>
              )}
              {!liveRestore && (
                <label className="checkbox">
                  <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
                  {m.start}
                </label>
              )}
              <Field label={m.bwlimit}>
                <input type="number" min="0" value={bwlimit} placeholder="—" onChange={(e) => setBwlimit(e.target.value)} />
              </Field>
            </>
          ) : effectiveAction === 'vm-files' ? (
            <>
              <Field label={m.targetPath} help={m.targetPathHelp}>
                <input type="text" value={targetPath} onChange={(e) => setTargetPath(e.target.value)} />
              </Field>
              <Field label={m.vmPaths} help={m.vmPathsHelp}>
                <textarea placeholder={'/etc/nginx\np2:/var/www'} value={paths} onChange={(e) => setPaths(e.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field label={m.targetCt}>
                <select value={targetVmid} onChange={(e) => setTargetVmid(Number(e.target.value))}>
                  {containers.map((c) => (
                    <option key={c.vmid} value={c.vmid}>{`${c.vmid} · ${c.name} (${c.node})`}</option>
                  ))}
                </select>
              </Field>
              <Field label={m.paths} help={m.pathsHelp}>
                <textarea placeholder={'/etc/nginx\n/var/www'} value={paths} onChange={(e) => setPaths(e.target.value)} />
              </Field>
            </>
          )}
        </div>
      )}
    </FormModal>
  );
}

// --- Run items ------------------------------------------------------------------------

/** Per-guest rows of a Proxmox backup run; refreshes while the run is active. */
export function ProxmoxRunItemsModal({
  runId,
  jobName,
  active,
  onClose,
}: {
  runId: string;
  jobName: string;
  active: boolean;
  onClose: () => void;
}) {
  const m = useT().proxmox.runItems;
  return (
    <ModalFrame title={m.title(jobName)} wide onClose={onClose}>
      <ProxmoxRunItemsList runId={runId} active={active} />
    </ModalFrame>
  );
}

// --- Dashboard ------------------------------------------------------------------------

/**
 * Proxmox guests that need attention: not covered by a job, latest backup
 * failed, or on a node without an agent. Hidden when there is nothing to
 * report (the summary is admin-only and simply fails for other users).
 */
export function ProxmoxAttention() {
  const t = useT();
  const m = t.dashboard.proxmox;
  const navigate = useNavigate();
  const { data } = useAsync(() => proxmoxApi.summary().catch(() => null as ProxmoxSummary | null));
  if (!data || (data.unprotected.length === 0 && data.failed.length === 0 && data.nodesWithoutAgent.length === 0)) {
    return null;
  }
  const red = 'var(--red, #e5534b)';
  const items = [
    ...data.nodesWithoutAgent.map((n) => ({
      key: `node:${n.clusterId}:${n.node}`,
      clusterId: n.clusterId,
      title: m.node(n.node),
      sub: `${n.clusterName} · `,
      label: m.noAgent,
      error: undefined as string | undefined,
      color: red,
    })),
    ...data.failed.map((g) => ({
      key: `f:${g.clusterId}:${g.vmid}`,
      clusterId: g.clusterId,
      title: `${g.vmid} · ${g.name}`,
      sub: `${g.clusterName} · `,
      label: m.failed,
      error: g.error,
      color: red,
    })),
    ...data.unprotected.map((g) => ({
      key: `u:${g.clusterId}:${g.vmid}`,
      clusterId: g.clusterId,
      title: `${g.vmid} · ${g.name}`,
      sub: `${g.clusterName} · `,
      label: m.unprotected,
      error: undefined as string | undefined,
      color: 'var(--warn)',
    })),
  ];
  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>{m.title(data.unprotected.length, data.failed.length, data.nodesWithoutAgent.length)}</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/proxmox')}>
          <Icon name="server" size={14} />
          {m.open}
        </button>
      </div>
      {items.slice(0, 8).map((v) => (
        <div key={v.key} className="row" style={{ cursor: 'pointer' }} onClick={() => navigate(`/proxmox/${v.clusterId}`)}>
          <span className="status-dot" style={{ background: v.color }} />
          <div className="row-main">
            <div className="row-title">{v.title}</div>
            <div className="row-sub" title={v.error ?? ''}>
              {v.sub}
              <span style={{ color: v.color }}>{v.label}</span>
              {v.error && <> · {v.error.length > 120 ? `${v.error.slice(0, 120)}…` : v.error}</>}
            </div>
          </div>
        </div>
      ))}
      {items.length > 8 && <div className="muted" style={{ padding: '10px 16px', fontSize: 12 }}>{m.more(items.length - 8)}</div>}
    </div>
  );
}
