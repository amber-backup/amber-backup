export const backendFields = {
  publicKey: {
    // Split around the <code> path so it can be rendered inline.
    instructionsBefore: "Add this public key to the SFTP server (append it to the backup user's",
    instructionsAfter: '). Then use “Test” to verify the connection.',
    copy: 'Copy public key',
    copied: 'Public key copied',
    copyFailed: 'Copy failed',
  },
};

export type BackendFieldsMessages = typeof backendFields;
