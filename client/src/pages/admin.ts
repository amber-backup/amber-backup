import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader } from '../core/layout';
import { api } from '../core/api';
import { toast, confirmDialog, copyToClipboard, field } from '../core/ui';

interface GlobalEnroll {
  enabled: boolean;
  token: string | null;
}

type SsoProviderType = 'oidc' | 'entra' | 'google' | 'github';

interface SsoProviderView {
  id: string;
  type: SsoProviderType;
  label: string;
  clientId: string;
  issuerUrl: string;
  tenantId: string;
  clientSecretSet: boolean;
}

interface SystemSettings {
  agentOfflineTimeoutSeconds: number;
  sso: { enabled: boolean; providers: SsoProviderView[] };
  ssoRedirectUri: string;
}

/** Provider kinds selectable in the "Add provider" menu. */
const SSO_PROVIDER_META: {
  type: SsoProviderType;
  name: string;
  issuer?: boolean;
  tenant?: boolean;
}[] = [
  { type: 'oidc', name: 'OpenID Connect (OIDC)', issuer: true },
  { type: 'entra', name: 'Microsoft Entra ID', tenant: true },
  { type: 'google', name: 'Google' },
  { type: 'github', name: 'GitHub' },
];

const MONO_STYLE =
  'background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;word-break:break-all;color:var(--amber-light)';

const BODY_STYLE = 'padding:16px 20px;display:flex;flex-direction:column;gap:16px';
const ACTIONS_STYLE = 'display:flex;justify-content:flex-end';
const SUBHEAD_STYLE =
  'font-size:12.5px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.04em;margin-top:4px';

/** Admin-only system settings (agent self-registration, timeouts, SSO). */
export async function renderAdmin(): Promise<Node> {
  const enrollPanel = h('div', { class: 'panel' });
  const agentPanel = h('div', { class: 'panel section-gap' });
  const ssoPanel = h('div', { class: 'panel section-gap' });

  // --- Agent self-registration ---------------------------------------------

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
      const tokenBox = h('div', { class: 'mono', style: `${MONO_STYLE};flex:1;min-width:0` }, token);
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
            h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:6px' },
              tokenBox,
              copyBtn,
              rotateBtn,
            ),
          ),
        ),
      );
    }
    enrollPanel.replaceChildren(...children);
  };

  // --- Agent offline timeout -----------------------------------------------

  const renderAgentSettings = (sys: SystemSettings): void => {
    const input = h('input', {
      type: 'number',
      min: '30',
      max: '3600',
      value: String(sys.agentOfflineTimeoutSeconds),
    }) as HTMLInputElement;
    input.style.maxWidth = '160px';

    const saveBtn = h('button', { class: 'btn btn-primary btn-sm' }, 'Save');
    saveBtn.addEventListener('click', async () => {
      const seconds = Number(input.value);
      if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
        toast('Enter a whole number between 30 and 3600 seconds', 'error');
        return;
      }
      try {
        await api.patch('/settings/agents', { offlineTimeoutSeconds: seconds });
        toast('Agent settings saved', 'success');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Error', 'error');
      }
    });

    agentPanel.replaceChildren(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Agents')),
      h('div', { style: BODY_STYLE },
        field(
          'Offline timeout (seconds)',
          input,
          'After how long without a poll an agent is marked offline. 30–3600 seconds.',
        ),
        h('div', { style: ACTIONS_STYLE }, saveBtn),
      ),
    );
  };

  // --- SSO -----------------------------------------------------------------

  const renderSso = (sys: SystemSettings): void => {
    const enabledToggle = h('input', { type: 'checkbox', checked: sys.sso.enabled }) as HTMLInputElement;

    // Redirect URI hint.
    const redirectBox = h('div', { class: 'mono', style: MONO_STYLE }, sys.ssoRedirectUri);
    const copyRedirect = h('button', { class: 'btn btn-ghost btn-sm', title: 'Copy redirect URI' }, icon('copy'));
    copyRedirect.addEventListener('click', async () => {
      const ok = await copyToClipboard(sys.ssoRedirectUri);
      toast(ok ? 'Redirect URI copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
    });

    // Provider cards, each exposing a collect() for the save payload.
    const cards: { el: HTMLElement; collect: () => Record<string, unknown> }[] = [];
    const listEl = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
    const emptyHint = h('div', { class: 'row-sub', style: 'padding:2px 0' }, 'No providers yet. Add one below.');

    const syncEmpty = () => {
      if (cards.length === 0) listEl.append(emptyHint);
      else emptyHint.remove();
    };

    const buildCard = (v: SsoProviderView): void => {
      const meta = SSO_PROVIDER_META.find((m) => m.type === v.type)!;
      const label = h('input', { class: 'input', type: 'text', value: v.label, placeholder: meta.name }) as HTMLInputElement;
      const clientId = h('input', { class: 'input', type: 'text', value: v.clientId }) as HTMLInputElement;
      const secret = h('input', {
        class: 'input',
        type: 'password',
        placeholder: v.clientSecretSet ? '•••••••• (unchanged)' : 'Client secret',
      }) as HTMLInputElement;
      const issuer = meta.issuer
        ? (h('input', { class: 'input', type: 'text', value: v.issuerUrl, placeholder: 'https://id.example.com' }) as HTMLInputElement)
        : undefined;
      const tenant = meta.tenant
        ? (h('input', { class: 'input', type: 'text', value: v.tenantId, placeholder: 'directory (tenant) id' }) as HTMLInputElement)
        : undefined;

      const removeBtn = h('button', { class: 'btn btn-ghost btn-sm', title: 'Remove provider' }, icon('trash'));

      const card = h(
        'div',
        { style: 'border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:var(--bg-2);display:flex;flex-direction:column;gap:12px' },
        h('div', { style: 'display:flex;align-items:center;justify-content:space-between' },
          h('div', { style: 'font-weight:600;font-size:13.5px' }, meta.name),
          removeBtn,
        ),
        issuer ? field('Issuer URL', issuer, 'Base URL exposing /.well-known/openid-configuration.') : (null as never),
        tenant ? field('Directory (tenant) ID', tenant) : (null as never),
        field('Client ID', clientId),
        field('Client secret', secret, v.clientSecretSet ? 'A secret is stored. Leave blank to keep it.' : undefined),
        field('Login button label (optional)', label, `Defaults to "${meta.name}".`),
      );

      const entry = {
        el: card,
        collect: (): Record<string, unknown> => ({
          id: v.id || undefined,
          type: v.type,
          label: label.value.trim(),
          clientId: clientId.value.trim(),
          issuerUrl: issuer ? issuer.value.trim() : undefined,
          tenantId: tenant ? tenant.value.trim() : undefined,
          clientSecret: secret.value, // blank leaves the stored secret unchanged
        }),
      };
      removeBtn.addEventListener('click', () => {
        const i = cards.indexOf(entry);
        if (i >= 0) cards.splice(i, 1);
        card.remove();
        syncEmpty();
      });
      cards.push(entry);
      emptyHint.remove();
      listEl.append(card);
    };

    sys.sso.providers.forEach(buildCard);
    syncEmpty();

    // "Add provider" button + dropdown menu.
    const menu = h('div', { class: 'dropdown-menu', style: 'display:none' });
    const addBtn = h('button', { class: 'btn btn-ghost btn-sm' }, icon('plus'), 'Add provider');
    const dropdown = h('div', { class: 'dropdown' }, addBtn, menu);

    const closeMenu = () => {
      menu.style.display = 'none';
      document.removeEventListener('click', onDocClick);
    };
    const onDocClick = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) closeMenu();
    };
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.style.display !== 'none';
      if (open) return closeMenu();
      menu.style.display = 'flex';
      document.addEventListener('click', onDocClick);
    });
    for (const m of SSO_PROVIDER_META) {
      const opt = h('button', { class: 'dropdown-item' }, m.name);
      opt.addEventListener('click', () => {
        closeMenu();
        buildCard({ id: '', type: m.type, label: '', clientId: '', issuerUrl: '', tenantId: '', clientSecretSet: false });
      });
      menu.append(opt);
    }

    const saveBtn = h('button', { class: 'btn btn-primary btn-sm' }, 'Save SSO');
    saveBtn.addEventListener('click', async () => {
      try {
        const updated = await api.put<SystemSettings>('/settings/sso', {
          enabled: enabledToggle.checked,
          providers: cards.map((c) => c.collect()),
        });
        toast('SSO configuration saved', 'success');
        renderSso(updated);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Error', 'error');
      }
    });

    // Editor is only shown when SSO is enabled.
    const editor = h(
      'div',
      { style: `display:${sys.sso.enabled ? 'flex' : 'none'};flex-direction:column;gap:16px` },
      h('div', { class: 'row', style: 'padding:0' },
        h('div', { class: 'row-main', style: 'min-width:0' },
          h('div', { class: 'row-title' }, 'Redirect URI'),
          h('div', { class: 'row-sub' }, 'Register this callback URL with every provider.'),
          redirectBox,
        ),
        h('div', { class: 'row-actions' }, copyRedirect),
      ),
      h('div', { style: SUBHEAD_STYLE }, 'Providers'),
      listEl,
      h('div', {}, dropdown),
    );
    enabledToggle.addEventListener('change', () => {
      editor.style.display = enabledToggle.checked ? 'flex' : 'none';
    });

    ssoPanel.replaceChildren(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Single sign-on')),
      h('div', { style: BODY_STYLE },
        h('label', { class: 'checkbox' }, enabledToggle, 'Enable single sign-on'),
        editor,
        h('div', { style: ACTIONS_STYLE }, saveBtn),
      ),
    );
  };

  // --- Load ----------------------------------------------------------------

  enrollPanel.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading…'));
  agentPanel.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading…'));
  ssoPanel.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading…'));

  void renderEnroll();
  void (async () => {
    try {
      const sys = await api.get<SystemSettings>('/settings/system');
      renderAgentSettings(sys);
      renderSso(sys);
    } catch {
      const err = h('div', { class: 'empty' }, 'Failed to load system settings.');
      agentPanel.replaceChildren(err.cloneNode(true));
      ssoPanel.replaceChildren(err);
    }
  })();

  return h('div', {},
    pageHeader('Admin', 'System-wide settings'),
    enrollPanel,
    agentPanel,
    ssoPanel,
  );
}
