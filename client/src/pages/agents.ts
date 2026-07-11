import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, Agent } from '../core/api';
import { router } from '../core/router';
import { openModal, toast, confirmDialog, fmtRelative, copyToClipboard } from '../core/ui';

interface EnrollToken {
  token: string;
  expiresAt: string;
  deployMethod: string;
  installCommand: string;
}

export async function renderAgents(): Promise<Node> {
  const agents = await api.get<Agent[]>('/agents');
  const online = agents.filter((a) => a.status === 'online').length;

  const head = h(
    'div',
    { class: 'table-head', style: 'grid-template-columns:1.6fr 1fr 1fr 1fr 40px' },
    h('span', {}, 'Host'),
    h('span', {}, 'Agent'),
    h('span', {}, 'Last contact'),
    h('span', {}, 'Restic'),
    h('span', {}),
  );

  const rows =
    agents.length === 0
      ? [h('div', { class: 'empty' }, 'No agents yet. Roll out an agent on a remote server.')]
      : agents.map(agentRow);

  const panel = h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Server fleet')), agents.length ? head : (null as never), ...rows);

  return h(
    'div',
    {},
    pageHeader('Agents', `${online} of ${agents.length} online`, [
      actionButton('Roll out agent', 'plus', openEnroll, 'primary'),
    ]),
    panel,
  );
}

function agentRow(a: Agent): HTMLElement {
  return h(
    'div',
    { class: 'row', style: 'display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr 40px;gap:14px' },
    h(
      'div',
      { style: 'display:flex;align-items:center;gap:11px;min-width:0' },
      h('span', { class: `status-dot ${a.status}` }),
      h(
        'div',
        { style: 'min-width:0' },
        h('div', { class: 'row-title' }, a.name),
        h('div', { class: 'row-sub' }, `${a.hostname ?? '?'} · ${a.os ?? ''}`),
      ),
    ),
    h('div', { class: 'mono', style: 'font-size:12.5px;color:var(--text-2)' }, a.agent_version ? `v${a.agent_version}` : h('span', { class: 'badge info' }, 'installing…')),
    h('div', { style: `font-size:12.5px;color:var(--${a.status === 'offline' ? 'danger' : 'text-2'})` }, a.last_seen_at ? fmtRelative(a.last_seen_at) : 'never'),
    h('div', { class: 'mono', style: 'font-size:12.5px;color:var(--text-3)' }, a.restic_version ?? '—'),
    h(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        onclick: () =>
          confirmDialog('Remove agent', `"${a.name}" will be removed. The agent will no longer be able to check in.`, async () => {
            await api.del(`/agents/${a.id}`);
            toast('Agent removed', 'success');
            router.navigate('/agents');
          }, true),
      },
      icon('trash'),
    ),
  );
}

interface GlobalEnroll {
  enabled: boolean;
  token: string | null;
  commands: Record<string, string> | null;
  namePlaceholder: string;
}

const CMD_STYLE =
  'background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--amber-light)';

function methodSelect(): HTMLSelectElement {
  return h(
    'select',
    {},
    h('option', { value: 'binary' }, 'Binary (systemd)'),
    h('option', { value: 'docker' }, 'Docker'),
    h('option', { value: 'docker-compose' }, 'Docker Compose'),
  ) as HTMLSelectElement;
}

function intro(method: string): string {
  return method === 'docker-compose'
    ? 'Save as docker-compose.yml on the target server, then run "docker compose up -d":'
    : 'Run on the target server:';
}

async function openEnroll(): Promise<void> {
  let global: GlobalEnroll = { enabled: false, token: null, commands: null, namePlaceholder: '' };
  try {
    global = await api.get<GlobalEnroll>('/agents/enrollment/global');
  } catch {
    /* fall back to one-time tokens */
  }
  if (global.enabled && global.commands) openGlobalRollout(global);
  else openTokenRollout();
}

/** Self-registration: the global token is already active; just pick a name. */
function openGlobalRollout(global: GlobalEnroll): void {
  const nameInput = h('input', { type: 'text', placeholder: 'e.g. web-01' });
  const method = methodSelect();
  const cmdBox = h('div', { class: 'mono', style: CMD_STYLE });
  const introEl = h('p', { style: 'font-size:13px;color:var(--text-2);margin-bottom:10px' });
  const hint = h('div', { class: 'help', style: 'color:var(--text-2)' }, 'Enter an agent name to get the command.');
  const copyBtn = h('button', { class: 'btn btn-ghost btn-sm' }, icon('copy'), 'Copy');

  const shownCommand = (): string =>
    (global.commands![method.value] ?? '').replaceAll(
      global.namePlaceholder,
      nameInput.value.trim() || '<agent-name>',
    );

  const update = (): void => {
    const ready = !!nameInput.value.trim();
    introEl.textContent = intro(method.value);
    cmdBox.textContent = shownCommand();
    copyBtn.toggleAttribute('disabled', !ready);
    hint.style.display = ready ? 'none' : 'block';
  };
  nameInput.addEventListener('input', update);
  method.addEventListener('change', update);
  copyBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) return;
    const ok = await copyToClipboard(shownCommand());
    toast(ok ? 'Command copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
  });
  update();

  openModal({
    title: 'Roll out agent',
    body: h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:16px' },
      h('div', { class: 'field' }, h('label', {}, 'Agent name'), nameInput),
      h('div', { class: 'field' }, h('label', {}, 'Method'), method),
      introEl,
      cmdBox,
      hint,
      h('div', {}, copyBtn),
    ),
  });
}

/** One-time tokens: generate a short-lived token per agent. */
function openTokenRollout(): void {
  const nameInput = h('input', { type: 'text', placeholder: 'e.g. web-01 (optional)' });
  const method = methodSelect();
  const result = h('div', {});

  const generateBtn = h('button', { class: 'btn btn-primary' }, 'Generate token');
  generateBtn.addEventListener('click', async () => {
    generateBtn.setAttribute('disabled', '');
    try {
      const res = await api.post<EnrollToken>('/agents/enrollment-tokens', {
        intendedAgentName: nameInput.value || undefined,
        deployMethod: method.value,
        expiresInMinutes: 60,
      });
      const cmd = h('div', { class: 'mono', style: CMD_STYLE }, res.installCommand);
      const copyBtn = h('button', { class: 'btn btn-ghost btn-sm' }, icon('copy'), 'Copy');
      copyBtn.addEventListener('click', async () => {
        const ok = await copyToClipboard(res.installCommand);
        toast(ok ? 'Command copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
      });
      result.replaceChildren(
        h('p', { style: 'font-size:13px;color:var(--text-2);margin-bottom:10px' }, `${intro(res.deployMethod)} (valid for 60 min):`),
        cmd,
        h('div', { style: 'margin-top:10px' }, copyBtn),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    } finally {
      generateBtn.removeAttribute('disabled');
    }
  });

  openModal({
    title: 'Roll out agent',
    body: h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:16px' },
      h('div', { class: 'field' }, h('label', {}, 'Agent name'), nameInput),
      h('div', { class: 'field' }, h('label', {}, 'Method'), method),
      h('div', {}, generateBtn),
      result,
    ),
  });
}
