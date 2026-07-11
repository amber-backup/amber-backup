import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader } from '../core/layout';
import { api } from '../core/api';
import { toast, confirmDialog, copyToClipboard } from '../core/ui';

interface GlobalEnroll {
  enabled: boolean;
  token: string | null;
}

const MONO_STYLE =
  'background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;word-break:break-all;color:var(--amber-light)';

/** Admin-only system settings (agent self-registration, …). */
export async function renderAdmin(): Promise<Node> {
  const enrollPanel = h('div', { class: 'panel' });

  const renderEnroll = async (): Promise<void> => {
    let g: GlobalEnroll;
    try {
      g = await api.get<GlobalEnroll>('/agents/enrollment/global');
    } catch {
      enrollPanel.replaceChildren(
        h('div', { class: 'empty' }, 'Failed to load enrollment settings.'),
      );
      return;
    }
    const toggle = h('input', { type: 'checkbox', checked: g.enabled }) as HTMLInputElement;
    toggle.addEventListener('change', async () => {
      try {
        await api.patch('/agents/enrollment/global', { enabled: toggle.checked });
        toast(toggle.checked ? 'Self-registration enabled' : 'Self-registration disabled', 'success');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Error', 'error');
      }
      void renderEnroll();
    });

    const children: Node[] = [
      h('div', { class: 'panel-head' }, h('h2', {}, 'Agent self-registration')),
      h('div', { class: 'row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, 'Global enrollment token'),
          h('div', { class: 'row-sub' }, 'When enabled, agents register themselves with this shared token — they choose their own name and exchange the token for their own credential.'),
        ),
        h('label', { class: 'checkbox' }, toggle, 'Enabled'),
      ),
    ];

    if (g.enabled && g.token) {
      const token = g.token;
      const tokenBox = h('div', { class: 'mono', style: MONO_STYLE }, token);
      const copyBtn = h('button', { class: 'btn btn-ghost btn-sm', title: 'Copy token' }, icon('copy'));
      copyBtn.addEventListener('click', async () => {
        const ok = await copyToClipboard(token);
        toast(ok ? 'Token copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
      });
      const rotateBtn = h('button', { class: 'btn btn-ghost btn-sm', title: 'Rotate token' }, icon('refresh'));
      rotateBtn.addEventListener('click', () =>
        confirmDialog(
          'Rotate global token',
          'The current token stops working for new rollouts. Agents already enrolled keep working.',
          async () => {
            await api.post('/agents/enrollment/global/rotate');
            toast('Token rotated', 'success');
            void renderEnroll();
          },
        ),
      );
      children.push(
        h('div', { class: 'row' },
          h('div', { class: 'row-main', style: 'min-width:0' },
            h('div', { class: 'row-title' }, 'Token'),
            tokenBox,
          ),
          h('div', { class: 'row-actions' }, copyBtn, rotateBtn),
        ),
      );
    }
    enrollPanel.replaceChildren(...children);
  };

  enrollPanel.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading…'));
  void renderEnroll();

  return h('div', {},
    pageHeader('Admin', 'System-wide settings'),
    enrollPanel,
  );
}
