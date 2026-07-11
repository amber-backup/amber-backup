import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader } from '../core/layout';
import { api } from '../core/api';
import { toast, confirmDialog, copyToClipboard, field } from '../core/ui';

interface GlobalEnroll {
  enabled: boolean;
  token: string | null;
}

interface SystemSettings {
  agentOfflineTimeoutSeconds: number;
  sso: {
    oidc: { enabled: boolean; issuerUrl: string; clientId: string; clientSecretSet: boolean };
    entra: { enabled: boolean; tenantId: string; clientId: string; clientSecretSet: boolean };
  };
  ssoRedirectUri: string;
}

const MONO_STYLE =
  'background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;word-break:break-all;color:var(--amber-light)';

const BODY_STYLE = 'padding:16px 20px;display:flex;flex-direction:column;gap:16px';
const ACTIONS_STYLE = 'display:flex;justify-content:flex-end';
const SUBHEAD_STYLE =
  'font-size:12.5px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.04em;margin-top:4px';

/** Admin-only system settings (agent self-registration, timeouts, SSO). */
export async function renderAdmin(): Promise<Node> {
  const enrollPanel = h('div', { class: 'panel' });
  const agentPanel = h('div', { class: 'panel' });
  const ssoPanel = h('div', { class: 'panel' });

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
    const oidc = sys.sso.oidc;
    const entra = sys.sso.entra;

    const oidcEnabled = h('input', { type: 'checkbox', checked: oidc.enabled }) as HTMLInputElement;
    const oidcIssuer = h('input', { type: 'text', value: oidc.issuerUrl, placeholder: 'https://id.example.com' }) as HTMLInputElement;
    const oidcClientId = h('input', { type: 'text', value: oidc.clientId }) as HTMLInputElement;
    const oidcSecret = h('input', {
      type: 'password',
      placeholder: oidc.clientSecretSet ? '•••••••• (unchanged)' : 'Client secret',
    }) as HTMLInputElement;

    const entraEnabled = h('input', { type: 'checkbox', checked: entra.enabled }) as HTMLInputElement;
    const entraTenant = h('input', { type: 'text', value: entra.tenantId, placeholder: 'tenant id' }) as HTMLInputElement;
    const entraClientId = h('input', { type: 'text', value: entra.clientId }) as HTMLInputElement;
    const entraSecret = h('input', {
      type: 'password',
      placeholder: entra.clientSecretSet ? '•••••••• (unchanged)' : 'Client secret',
    }) as HTMLInputElement;

    const redirectBox = h('div', { class: 'mono', style: MONO_STYLE }, sys.ssoRedirectUri);
    const copyRedirect = h('button', { class: 'btn btn-ghost btn-sm', title: 'Copy redirect URI' }, icon('copy'));
    copyRedirect.addEventListener('click', async () => {
      const ok = await copyToClipboard(sys.ssoRedirectUri);
      toast(ok ? 'Redirect URI copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
    });

    const saveBtn = h('button', { class: 'btn btn-primary btn-sm' }, 'Save SSO');
    saveBtn.addEventListener('click', async () => {
      const body = {
        oidc: {
          enabled: oidcEnabled.checked,
          issuerUrl: oidcIssuer.value.trim(),
          clientId: oidcClientId.value.trim(),
          clientSecret: oidcSecret.value, // blank leaves it unchanged
        },
        entra: {
          enabled: entraEnabled.checked,
          tenantId: entraTenant.value.trim(),
          clientId: entraClientId.value.trim(),
          clientSecret: entraSecret.value,
        },
      };
      try {
        const updated = await api.put<SystemSettings>('/settings/sso', body);
        toast('SSO configuration saved', 'success');
        renderSso(updated);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Error', 'error');
      }
    });

    ssoPanel.replaceChildren(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Single sign-on')),
      h('div', { style: BODY_STYLE },
        h('div', { class: 'row', style: 'padding:0' },
          h('div', { class: 'row-main', style: 'min-width:0' },
            h('div', { class: 'row-title' }, 'Redirect URI'),
            h('div', { class: 'row-sub' }, 'Register this callback URL with your identity provider.'),
            redirectBox,
          ),
          h('div', { class: 'row-actions' }, copyRedirect),
        ),
        h('div', { style: SUBHEAD_STYLE }, 'Generic OIDC'),
        h('label', { class: 'checkbox' }, oidcEnabled, 'Enable OIDC login'),
        field('Issuer URL', oidcIssuer, 'The provider base URL exposing /.well-known/openid-configuration.'),
        field('Client ID', oidcClientId),
        field('Client secret', oidcSecret, oidc.clientSecretSet ? 'A secret is stored. Leave blank to keep it.' : undefined),
        h('div', { style: SUBHEAD_STYLE }, 'Microsoft Entra ID'),
        h('label', { class: 'checkbox' }, entraEnabled, 'Enable Microsoft login'),
        field('Tenant ID', entraTenant),
        field('Client ID', entraClientId),
        field('Client secret', entraSecret, entra.clientSecretSet ? 'A secret is stored. Leave blank to keep it.' : undefined),
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
