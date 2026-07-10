import { h, clear } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader } from '../core/layout';
import { api, Target, Snapshot, LsEntry, RestoreRun } from '../core/api';
import { openModal, toast, field, fmtBytes, fmtDateTime, fmtRelative, statusLabel } from '../core/ui';

export async function renderRestore(): Promise<Node> {
  const targets = await api.get<Target[]>('/targets');

  const targetSelect = h(
    'select',
    { style: 'max-width:280px' },
    h('option', { value: '' }, '— Select target —'),
    ...targets.map((t) => h('option', { value: t.id }, t.name)),
  );

  const snapPanel = h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'Select a target to browse snapshots.'));
  const historyPanel = h('div', { class: 'panel section-gap' });

  const loadSnapshots = async (targetId: string) => {
    if (!targetId) {
      snapPanel.replaceChildren(h('div', { class: 'empty' }, 'Select a target to browse snapshots.'));
      return;
    }
    snapPanel.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading snapshots…'));
    try {
      const snaps = await api.get<Snapshot[]>(`/targets/${targetId}/snapshots`);
      snapPanel.replaceChildren(
        h('div', { class: 'panel-head' }, h('h2', {}, `Snapshots (${snaps.length})`)),
        ...(snaps.length === 0
          ? [h('div', { class: 'empty' }, 'No snapshots in this repository.')]
          : snaps.map((s) => snapshotRow(targetId, s))),
      );
    } catch (err) {
      snapPanel.replaceChildren(h('div', { class: 'empty' }, err instanceof Error ? err.message : 'Failed to load'));
    }
  };

  targetSelect.addEventListener('change', () => void loadSnapshots(targetSelect.value));

  await loadHistory(historyPanel);

  return h(
    'div',
    {},
    pageHeader('Restore', 'Browse snapshots and restore selectively or in full', [
      h('div', { class: 'field', style: 'flex-direction:row;align-items:center;gap:10px' }, targetSelect),
    ]),
    snapPanel,
    historyPanel,
  );
}

function snapshotRow(targetId: string, s: Snapshot): HTMLElement {
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'stat-icon', style: 'background:var(--amber-glow);color:var(--amber)' }, icon('snapshot', 16)),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, `${s.hostname} · ${s.paths.join(', ')}`),
      h('div', { class: 'row-sub' }, `${s.short_id ?? s.id.slice(0, 8)} · ${fmtDateTime(s.time)}`),
    ),
    s.tags && s.tags.length ? h('div', { class: 'tags' }, ...s.tags.map((t) => h('span', { class: 'tag' }, t))) : (null as never),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openBrowser(targetId, s) }, icon('folder'), 'Browse'),
    h('button', { class: 'btn btn-primary btn-sm', onclick: () => openRestoreDialog(targetId, s, []) }, icon('restore'), 'Restore'),
  );
}

function openBrowser(targetId: string, snap: Snapshot): void {
  const selected = new Set<string>();
  const crumbs = h('div', { class: 'fb-crumbs' });
  const listEl = h('div', {});
  const fb = h('div', { class: 'fb' }, crumbs, listEl);

  const load = async (path: string) => {
    listEl.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    renderCrumbs(path);
    try {
      const entries = await api.get<LsEntry[]>(
        `/targets/${targetId}/snapshots/${snap.id}/ls${path ? `?path=${encodeURIComponent(path)}` : ''}`,
      );
      listEl.replaceChildren(...entries.map(entryRow));
      if (entries.length === 0) listEl.replaceChildren(h('div', { class: 'empty' }, 'Empty directory.'));
    } catch (err) {
      listEl.replaceChildren(h('div', { class: 'empty' }, err instanceof Error ? err.message : 'Error'));
    }
  };

  const renderCrumbs = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    const items: Node[] = [h('span', { class: 'crumb', onclick: () => void load('') }, '/')];
    let acc = '';
    parts.forEach((p) => {
      acc += '/' + p;
      const target = acc;
      items.push(h('span', {}, '/'), h('span', { class: 'crumb', onclick: () => void load(target) }, p));
    });
    clear(crumbs);
    crumbs.append(...items);
  };

  const entryRow = (e: LsEntry) => {
    const isDir = e.type === 'dir';
    const check = h('input', { type: 'checkbox', onclick: (ev: Event) => ev.stopPropagation() }) as HTMLInputElement;
    check.checked = selected.has(e.path);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(e.path);
      else selected.delete(e.path);
      countLabel.textContent = `${selected.size} selected`;
    });
    return h(
      'div',
      { class: 'fb-item', onclick: () => isDir && void load(e.path) },
      check,
      h('span', { style: `color:var(--${isDir ? 'amber' : 'text-3'})` }, icon(isDir ? 'folder' : 'file')),
      h('span', { class: 'fb-name' }, e.name),
      h('span', { class: 'fb-size' }, isDir ? '' : fmtBytes(e.size)),
    );
  };

  const countLabel = h('span', { class: 'muted', style: 'font-size:12.5px' }, '0 selected');
  void load('');

  openModal({
    title: `Browse snapshot ${snap.short_id ?? snap.id.slice(0, 8)}`,
    wide: true,
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, fb, countLabel),
    confirmLabel: 'Restore selected',
    onConfirm: () => {
      const paths = [...selected];
      openRestoreDialog(targetId, snap, paths);
      return true;
    },
  });
}

function openRestoreDialog(targetId: string, snap: Snapshot, includedPaths: string[]): void {
  const modeSelect = h(
    'select',
    {},
    h('option', { value: 'download' }, 'Download (archive)'),
    h('option', { value: 'alternate_path' }, 'Alternate path (server)'),
    h('option', { value: 'original' }, 'Original location'),
  );
  const pathInput = h('input', { type: 'text', placeholder: '/tmp/restore-target' });
  const pathField = field('Target path', pathInput);
  const overwriteSelect = h(
    'select',
    {},
    h('option', { value: 'always' }, 'always (overwrite everything)'),
    h('option', { value: 'if-changed' }, 'if-changed'),
    h('option', { value: 'if-newer' }, 'if-newer'),
    h('option', { value: 'never' }, 'never'),
  );
  const verifyCheck = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const deleteCheck = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const warnBox = h('div', { class: 'warn-box', style: 'display:none' }, '⚠ Warning: --delete removes files in the target that are not in the snapshot.');

  deleteCheck.addEventListener('change', () => {
    warnBox.style.display = deleteCheck.checked ? 'block' : 'none';
  });

  const updateMode = () => {
    pathField.style.display = modeSelect.value === 'download' ? 'none' : 'flex';
  };
  modeSelect.addEventListener('change', updateMode);
  updateMode();

  const buildPayload = (dryRun: boolean) => ({
    targetId,
    snapshotId: snap.id,
    includedPaths: includedPaths.length ? includedPaths : undefined,
    mode: modeSelect.value,
    destination: modeSelect.value === 'download' ? {} : { path: pathInput.value },
    options: {
      overwrite: overwriteSelect.value,
      verify: verifyCheck.checked,
      delete: deleteCheck.checked,
      dryRun,
    },
  });

  const dryRunBtn = h('button', { class: 'btn btn-ghost' }, 'Dry run');
  dryRunBtn.addEventListener('click', async () => {
    try {
      await api.post('/restores', buildPayload(true));
      toast('Dry run started — see the history', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
  });

  openModal({
    title: `Restore${includedPaths.length ? ` (${includedPaths.length} paths)` : ''}`,
    body: h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:16px' },
      field('Mode', modeSelect),
      pathField,
      field('Overwrite', overwriteSelect),
      h('label', { class: 'checkbox' }, verifyCheck, 'Verify (--verify)'),
      h('label', { class: 'checkbox' }, deleteCheck, 'Delete foreign files (--delete)'),
      warnBox,
      h('div', {}, dryRunBtn),
    ),
    confirmLabel: 'Restore',
    onConfirm: async () => {
      try {
        await api.post('/restores', buildPayload(false));
        toast('Restore started', 'success');
        location.hash = '/restore';
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Error', 'error');
        return false;
      }
    },
  });
}

async function loadHistory(panel: HTMLElement): Promise<void> {
  const runs = await api.get<RestoreRun[]>('/restores?limit=15').catch(() => [] as RestoreRun[]);
  panel.replaceChildren(
    h('div', { class: 'panel-head' }, h('h2', {}, 'Restore history')),
    ...(runs.length === 0
      ? [h('div', { class: 'empty' }, 'No restores yet.')]
      : runs.map(historyRow)),
  );
}

function historyRow(r: RestoreRun): HTMLElement {
  const modeLabels: Record<string, string> = { original: 'Original', alternate_path: 'Alt. path', download: 'Download' };
  const canDownload = r.mode === 'download' && r.status === 'success' && (!r.download_expires_at || new Date(r.download_expires_at) > new Date());
  return h(
    'div',
    { class: 'row' },
    h('span', { class: `status-dot ${r.status}` }),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, `${modeLabels[r.mode] ?? r.mode} · ${r.snapshot_id.slice(0, 12)}`),
      h('div', { class: 'row-sub' }, `${statusLabel(r.status)} · ${fmtRelative(r.finished_at ?? r.created_at)}${r.error ? ' · ' + r.error : ''}`),
    ),
    canDownload
      ? h('a', { class: 'btn btn-ghost btn-sm', href: `/api/restores/${r.id}/download` }, icon('download'), 'Download')
      : (null as never),
  );
}
