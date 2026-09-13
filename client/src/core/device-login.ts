// Keeps a CLI pairing link (#/device?code=…) alive across sign-in: the login
// form navigates to '/' and SSO returns via a full-page redirect, both of which
// would otherwise drop the code. Only the code itself is stored, so nothing but
// the device page can ever be the post-login target.

const KEY = 'amber_device_code';
const CODE_RE = /^[A-Za-z-]{1,12}$/;

export function rememberDeviceCode(code: string | null): void {
  if (!code || !CODE_RE.test(code)) return;
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    /* storage unavailable: the user re-opens the link after signing in */
  }
}

/** Path to continue at after sign-in: the pending device page, or '/'. */
export function postLoginPath(): string {
  try {
    const code = sessionStorage.getItem(KEY);
    if (code && CODE_RE.test(code)) return `/device?code=${encodeURIComponent(code)}`;
  } catch {
    /* ignore */
  }
  return '/';
}

export function clearDeviceCode(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
