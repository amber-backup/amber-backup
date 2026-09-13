export const login = {
  email: 'Email',
  password: 'Password',
  signIn: 'Sign in',
  signInWithPasskey: 'Sign in with a passkey',
  signInWith: (provider: string) => `Sign in with ${provider}`,
  noMethod:
    'No sign-in method is available. An administrator has to enable local login or configure single sign-on.',
  codeLabel: 'Authentication code',
  codeHelp: 'Enter the 6-digit code from your authenticator app, or a recovery code.',
  verify: 'Verify',
  back: 'Back',
  signInFailed: 'Sign-in failed',
  verificationFailed: 'Verification failed',
  passkeyFailed: 'Passkey sign-in failed',
  sso: {
    pending: 'Your account is waiting for an administrator to approve it.',
    localAccount: 'This account signs in with a password. An administrator has to switch it to SSO first.',
    incomplete: 'Single sign-on did not complete.',
  },
};

export type LoginMessages = typeof login;
