import type { LoginMessages } from '../en/login';

export const login: LoginMessages = {
  email: 'E-Mail',
  password: 'Passwort',
  signIn: 'Anmelden',
  signInWithPasskey: 'Mit Passkey anmelden',
  signInWith: (provider: string) => `Mit ${provider} anmelden`,
  noMethod:
    'Es ist keine Anmeldemethode verfügbar. Ein Administrator muss die lokale Anmeldung aktivieren oder Single Sign-on einrichten.',
  codeLabel: 'Authentifizierungscode',
  codeHelp: 'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App oder einen Wiederherstellungscode ein.',
  verify: 'Bestätigen',
  back: 'Zurück',
  signInFailed: 'Anmeldung fehlgeschlagen',
  verificationFailed: 'Bestätigung fehlgeschlagen',
  passkeyFailed: 'Anmeldung mit Passkey fehlgeschlagen',
  sso: {
    pending: 'Ihr Konto wartet auf die Freigabe durch einen Administrator.',
    localAccount:
      'Dieses Konto meldet sich mit einem Passwort an. Ein Administrator muss es zuerst auf SSO umstellen.',
    ipNotAllowed: 'Administratoren können sich von dieser Adresse aus nicht anmelden.',
    incomplete: 'Single Sign-on wurde nicht abgeschlossen.',
  },
};
