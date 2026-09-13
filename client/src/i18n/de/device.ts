import type { DeviceMessages } from '../en/device';

export const device: DeviceMessages = {
  title: 'Geräteanmeldung',
  subtitle: 'Die Amber Backup CLI (ambb) auf einem anderen Gerät anmelden',
  lookingUp: 'Anfrage wird gesucht…',
  unknownCode:
    'Dieser Code ist unbekannt, abgelaufen oder wurde bereits verwendet. Führen Sie ambb login erneut aus, um einen neuen zu erhalten.',
  lookupFailed: 'Suche fehlgeschlagen',
  enter: {
    title: 'Code aus Ihrem Terminal eingeben',
    code: 'Code',
    codeHelp: 'Wird von ambb login angezeigt, z. B. BCDF-GHJK',
    continue: 'Weiter',
  },
  review: {
    title: 'Dieses Gerät zulassen?',
    warningBefore: 'Fahren Sie nur fort, wenn Sie ',
    warningMiddle:
      ' gerade selbst gestartet haben und Ihr Terminal genau diesen Code anzeigt. Falls Ihnen jemand diesen Link geschickt hat, lehnen Sie ab — beim Zulassen erhält das Gerät Zugriff auf Amber Backup als ',
    warningAfter: '.',
    device: 'Gerät',
    requestedFrom: 'Angefragt von',
    unknown: 'unbekannt',
    requested: 'Angefragt',
    expires: (at: string) => `Läuft ab: ${at}`,
    access: 'Zugriff',
    readHelp: 'Das Gerät kann auflisten und einsehen, aber keine Jobs ausführen oder etwas ändern.',
    fullHelp: 'Das Gerät kann alles, was Ihr Konto kann, außer Administration.',
    readOnly: 'Nur Lesezugriff',
    fullAccess: 'Vollzugriff',
    expiresAfter: 'Gültigkeitsdauer des Schlüssels',
    expiresAfterHelp: 'Danach muss sich das Gerät erneut anmelden.',
    days30: '30 Tage',
    days90: '90 Tage',
    year1: '1 Jahr',
    never: 'Unbegrenzt',
    deny: 'Ablehnen',
    approve: 'Zulassen',
    approving: 'Wird zugelassen…',
  },
  result: {
    approvedTitle: (client: string) => `${client} ist angemeldet`,
    deniedTitle: (client: string) => `Anmeldung von ${client} abgelehnt`,
    approvedHelp:
      'Die CLI schließt die Anmeldung innerhalb weniger Sekunden selbst ab. Sie können diesen Tab schließen. Der Schlüssel erscheint unter Einstellungen → API-Schlüssel, wo Sie ihn widerrufen können.',
    deniedHelp: 'Die CLI wartet nicht mehr. Es wurde kein Schlüssel ausgestellt.',
  },
};
