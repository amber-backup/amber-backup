import { h } from '../core/dom';
import { BRAND_MARK } from '../core/icons';
import { auth } from '../core/auth';
import { api } from '../core/api';
import { field } from '../core/ui';

export function renderLogin(): HTMLElement {
  const email = h('input', {
    type: 'email',
    placeholder: 'admin@example.com',
    value: '',
  });
  const password = h('input', { type: 'password', placeholder: '••••••••' });
  const errorBox = h('div', { class: 'login-error', style: 'display:none' });
  const submitBtn = h('button', { class: 'btn btn-primary', style: 'width:100%' }, 'Sign in');

  const showError = (msg: string) => {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
  };

  const doLogin = async () => {
    errorBox.style.display = 'none';
    submitBtn.setAttribute('disabled', '');
    try {
      await auth.login(email.value, password.value);
      location.hash = '/';
      location.reload();
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Sign-in failed');
      submitBtn.removeAttribute('disabled');
    }
  };

  submitBtn.addEventListener('click', doLogin);
  password.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void doLogin();
  });

  const form = h(
    'div',
    { class: 'login-card' },
    h('div', { class: 'login-brand', html: BRAND_MARK + '<div class="brand-name">Amber<span>Backup</span></div>' }),
    errorBox,
    field('Email', email),
    field('Password', password),
    submitBtn,
  );

  const ssoList = h('div', { class: 'sso-list' });
  void api
    .get<{ id: string; label: string }[]>('/auth/providers')
    .then((providers) => {
      for (const p of providers) {
        ssoList.append(
          h(
            'a',
            { class: 'btn btn-ghost', style: 'width:100%; justify-content:center', href: `/api/auth/oidc/${p.id}` },
            `Sign in with ${p.label}`,
          ),
        );
      }
    })
    .catch(() => undefined);
  form.append(ssoList);

  return h('div', { class: 'login-wrap' }, form);
}
