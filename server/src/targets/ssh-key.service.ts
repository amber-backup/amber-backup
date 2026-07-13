import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshKeyPair {
  /** OpenSSH private key (PEM), stored encrypted. */
  privateKey: string;
  /** `ssh-ed25519 AAAA... comment` line for the server's authorized_keys. */
  publicKey: string;
}

/**
 * Generates ed25519 SSH key pairs for SFTP targets. Shells out to `ssh-keygen`
 * so the output is in exactly the OpenSSH formats `ssh` and `authorized_keys`
 * expect (Node's crypto can't emit the `ssh-ed25519 AAAA...` public line).
 */
@Injectable()
export class SshKeyService {
  async generate(comment = 'amber-backup'): Promise<SshKeyPair> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-sshkey-'));
    const keyPath = path.join(dir, 'key');
    try {
      await this.runKeygen([
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        comment,
        '-f',
        keyPath,
        '-q',
      ]);
      const [privateKey, publicKey] = await Promise.all([
        fs.readFile(keyPath, 'utf8'),
        fs.readFile(`${keyPath}.pub`, 'utf8'),
      ]);
      return { privateKey, publicKey: publicKey.trim() };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private runKeygen(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh-keygen', args);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) =>
        reject(
          new InternalServerErrorException(
            `ssh-keygen unavailable: ${err.message}`,
          ),
        ),
      );
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new InternalServerErrorException(
              `ssh-keygen failed (${code}): ${stderr.trim()}`,
            ),
          );
      });
    });
  }
}
