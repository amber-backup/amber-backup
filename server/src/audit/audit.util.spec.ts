import { deriveAction, redactSecrets, singular } from './audit.util';

describe('audit redaction (never persist plaintext secrets)', () => {
  it('redacts secret-bearing keys anywhere in the object tree', () => {
    const input = {
      name: 'prod-repo',
      password: 'hunter2',
      config: {
        endpoint: 's3.example.com',
        accessKeyId: 'AKIA123',
        secretAccessKey: 'topsecret',
      },
      creds: { token: 'abc' },
      credentialBlob: { region: 'eu' },
      nested: [{ clientSecret: 'x' }, { webhookUrl: 'https://hook' }],
    };

    const out = redactSecrets(input) as any;

    expect(out.name).toBe('prod-repo');
    expect(out.config.endpoint).toBe('s3.example.com');
    // Every secret-ish field is masked, at any depth / inside arrays.
    expect(out.password).toBe('[redacted]');
    expect(out.config.accessKeyId).toBe('[redacted]');
    expect(out.config.secretAccessKey).toBe('[redacted]');
    expect(out.creds.token).toBe('[redacted]');
    expect(out.nested[0].clientSecret).toBe('[redacted]');
    expect(out.nested[1].webhookUrl).toBe('[redacted]');
    // A secret-named container is masked wholesale, not descended into.
    expect(out.credentialBlob).toBe('[redacted]');

    // No plaintext secret survives anywhere in the serialized output.
    const serialized = JSON.stringify(out);
    for (const secret of ['hunter2', 'topsecret', 'AKIA123', 'https://hook']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('does not mutate the original object', () => {
    const input = { password: 'hunter2' };
    redactSecrets(input);
    expect(input.password).toBe('hunter2');
  });

  it('passes through primitives and null unchanged', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets('plain')).toBe('plain');
    expect(redactSecrets(42)).toBe(42);
  });
});

describe('audit action derivation', () => {
  const cases: Array<[string, string, Record<string, string>, string, string | null]> = [
    ['POST', '/api/jobs', {}, 'Create job', 'job'],
    ['PATCH', '/api/jobs/j1', { id: 'j1' }, 'Update job', 'job'],
    ['DELETE', '/api/targets/t1', { id: 't1' }, 'Delete target', 'target'],
    ['POST', '/api/jobs/j1/run', { id: 'j1' }, 'Run job', 'job'],
    ['POST', '/api/runs/r1/cancel', { id: 'r1' }, 'Cancel run', 'run'],
    ['POST', '/api/users/u1/enable', { id: 'u1' }, 'Enable user', 'user'],
    ['POST', '/api/auth/logout', {}, 'Log out', 'auth'],
    ['POST', '/api/auth/change-password', {}, 'Change password', 'auth'],
  ];

  it.each(cases)('%s %s -> %s', (method, path, params, action, resourceType) => {
    const meta = deriveAction(method, path, params);
    expect(meta.action).toBe(action);
    expect(meta.resourceType).toBe(resourceType);
  });

  it('extracts the resource id from route params', () => {
    expect(deriveAction('DELETE', '/api/targets/abc', { id: 'abc' }).resourceId).toBe('abc');
    expect(deriveAction('POST', '/api/jobs/xyz/run', { id: 'xyz' }).resourceId).toBe('xyz');
  });

  it('singularizes common collection names', () => {
    expect(singular('jobs')).toBe('job');
    expect(singular('policies')).toBe('policy');
    expect(singular('addresses')).toBe('address');
  });
});
