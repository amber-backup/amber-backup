export const device = {
  title: 'Device login',
  subtitle: 'Sign in the Amber Backup CLI (ambb) on another device',
  lookingUp: 'Looking up the request…',
  unknownCode: 'This code is unknown, expired or already used. Run ambb login again for a new one.',
  lookupFailed: 'Lookup failed',
  enter: {
    title: 'Enter the code from your terminal',
    code: 'Code',
    codeHelp: 'Shown by ambb login, e.g. BCDF-GHJK',
    continue: 'Continue',
  },
  review: {
    title: 'Approve this device?',
    warningBefore: 'Only continue if you started ',
    warningMiddle:
      ' yourself just now and your terminal shows exactly this code. If someone sent you this link, deny it — approving gives that device access to Amber Backup as ',
    warningAfter: '.',
    device: 'Device',
    requestedFrom: 'Requested from',
    unknown: 'unknown',
    requested: 'Requested',
    expires: (at: string) => `Expires ${at}`,
    access: 'Access',
    readHelp: 'The device can list and inspect, but not run jobs or change anything.',
    fullHelp: 'The device can do everything your account can, except administration.',
    readOnly: 'Read-only',
    fullAccess: 'Full access',
    expiresAfter: 'Key expires after',
    expiresAfterHelp: 'The device has to sign in again afterwards.',
    days30: '30 days',
    days90: '90 days',
    year1: '1 year',
    never: 'Never',
    deny: 'Deny',
    approve: 'Approve',
    approving: 'Approving…',
  },
  result: {
    approvedTitle: (client: string) => `${client} is signed in`,
    deniedTitle: (client: string) => `Sign-in of ${client} denied`,
    approvedHelp:
      'The CLI finishes on its own within a few seconds. You can close this tab. The key is listed under Settings → API keys, where you can revoke it.',
    deniedHelp: 'The CLI stops waiting. No key was issued.',
  },
};

export type DeviceMessages = typeof device;
