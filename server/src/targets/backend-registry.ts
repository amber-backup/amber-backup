/**
 * Registry of supported restic backends (§6). Each definition declares its
 * config field schema (used to generate the client form), how to build the
 * restic repository string, and which environment variables / credential files
 * a restic invocation needs. Adding a backend = one new entry, no core change.
 *
 * A field's `scope` decides where it is configured:
 *   - `'target'` (default): the shared connection (endpoint, host, credentials).
 *   - `'job'`: the repository-specific part entered per backup job (bucket,
 *     prefix, path). One target/connection therefore serves many repositories.
 * `build()` receives both halves and composes the repository string from them.
 */

export type FieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'textarea'
  | 'select';

export type FieldScope = 'target' | 'job';

export interface BackendField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Secret fields are stored encrypted in the credential secret. */
  secret?: boolean;
  /** Where the field is configured. Defaults to 'target' when omitted. */
  scope?: FieldScope;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface CredentialFile {
  /**
   * Env var that should point at the written file (e.g.
   * GOOGLE_APPLICATION_CREDENTIALS). Leave empty when the file is only
   * referenced by path from `extraArgs` (e.g. an SSH private key).
   */
  envVar: string;
  filename: string;
  content: string;
}

export interface ResolvedBackend {
  repository: string;
  env: Record<string, string>;
  credentialFiles: CredentialFile[];
  /**
   * Extra restic global options (e.g. `['-o', 'sftp.command=...']`), prepended
   * before the subcommand at run time. May reference a credential file's
   * on-disk path via a `{{credentialFile:<filename>}}` placeholder — the
   * executor (server and agent) substitutes it once the file is written.
   */
  extraArgs?: string[];
}

/** Filename of the generated SSH private key for SFTP key-based auth. */
export const SFTP_KEY_FILENAME = 'sftp_id_ed25519';

/** Placeholder that resolves to a credential file's on-disk path in extraArgs. */
export function credentialFileRef(filename: string): string {
  return `{{credentialFile:${filename}}}`;
}

/** Replaces `{{credentialFile:NAME}}` tokens with each file's on-disk path. */
export function substituteCredentialPaths(
  args: string[],
  paths: Record<string, string>,
): string[] {
  return args.map((arg) =>
    arg.replace(/\{\{credentialFile:([^}]+)\}\}/g, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(paths, name) ? paths[name] : whole,
    ),
  );
}

export interface BackendDefinition {
  type: string;
  label: string;
  /**
   * Standalone backends are not selectable connections (no target row); they
   * are only offered as a per-job repository option (currently: local).
   */
  standalone?: boolean;
  fields: BackendField[];
  build(
    config: Record<string, unknown>,
    credentials: Record<string, string>,
    repoConfig: Record<string, unknown>,
  ): ResolvedBackend;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function joinPath(base: string, prefix?: unknown): string {
  const p = str(prefix).replace(/^\/+|\/+$/g, '');
  return p ? `${base}/${p}` : base;
}

export const BACKENDS: BackendDefinition[] = [
  {
    type: 'local',
    label: 'Local / Filesystem',
    standalone: true,
    fields: [
      {
        name: 'path',
        label: 'Path',
        type: 'text',
        required: true,
        scope: 'job',
        placeholder: '/srv/restic-repo',
      },
    ],
    build: (_config, _credentials, repoConfig) => ({
      repository: str(repoConfig.path),
      env: {},
      credentialFiles: [],
    }),
  },
  {
    type: 'sftp',
    label: 'SFTP (SSH)',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true },
      { name: 'user', label: 'User', type: 'text', required: true },
      { name: 'port', label: 'Port', type: 'number', placeholder: '22' },
      { name: 'path', label: 'Path', type: 'text', required: true, scope: 'job', placeholder: '/backups/restic' },
    ],
    build: (config, credentials, repoConfig) => {
      const host = str(config.host);
      const user = str(config.user);
      const path = str(repoConfig.path);
      const port = str(config.port);
      const repository = `sftp:${user}@${host}:${path}`;
      const privateKey = credentials.privateKey;

      // Without a generated key (e.g. a pre-save ad-hoc test) fall back to the
      // host's ambient SSH configuration — no custom command is injected.
      if (!privateKey) {
        return { repository, env: {}, credentialFiles: [] };
      }

      // Key-based auth: restic's sftp backend shells out to `ssh`, so we point
      // it at the generated private key via a custom sftp command.
      // `StrictHostKeyChecking=accept-new` trusts the server on first contact;
      // `BatchMode=yes` fails fast instead of hanging on a password prompt.
      const ssh = [
        'ssh',
        `${user}@${host}`,
        ...(port ? ['-p', port] : []),
        '-i',
        credentialFileRef(SFTP_KEY_FILENAME),
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'BatchMode=yes',
        '-s',
        'sftp',
      ];
      return {
        repository,
        env: {},
        credentialFiles: [
          { envVar: '', filename: SFTP_KEY_FILENAME, content: privateKey },
        ],
        extraArgs: ['-o', `sftp.command=${ssh.join(' ')}`],
      };
    },
  },
  {
    type: 'rest',
    label: 'REST Server',
    fields: [
      { name: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://backup.example.com/' },
      { name: 'username', label: 'Username', type: 'text', secret: true },
      { name: 'password', label: 'Password', type: 'password', secret: true },
    ],
    build: (config, credentials) => {
      let url = str(config.url).replace(/^https?:\/\//, '');
      const scheme = str(config.url).startsWith('http://') ? 'http' : 'https';
      const user = credentials.username;
      const pass = credentials.password;
      const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? '')}@` : '';
      return {
        repository: `rest:${scheme}://${auth}${url}`,
        env: {},
        credentialFiles: [],
      };
    },
  },
  {
    type: 's3',
    label: 'Amazon S3 / S3-compatible',
    fields: [
      { name: 'endpoint', label: 'Endpoint', type: 'text', required: true, placeholder: 's3.amazonaws.com' },
      { name: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1' },
      { name: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true, secret: true },
      { name: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true, secret: true },
      { name: 'bucket', label: 'Bucket', type: 'text', required: true, scope: 'job' },
      { name: 'prefix', label: 'Path prefix', type: 'text', scope: 'job' },
    ],
    build: (config, credentials, repoConfig) => ({
      repository: `s3:${joinPath(`${str(config.endpoint)}/${str(repoConfig.bucket)}`, repoConfig.prefix)}`,
      env: {
        AWS_ACCESS_KEY_ID: credentials.accessKeyId ?? '',
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey ?? '',
        ...(config.region ? { AWS_DEFAULT_REGION: str(config.region) } : {}),
      },
      credentialFiles: [],
    }),
  },
  {
    type: 'b2',
    label: 'Backblaze B2',
    fields: [
      { name: 'accountId', label: 'Account ID / Key ID', type: 'text', required: true, secret: true },
      { name: 'accountKey', label: 'Application Key', type: 'password', required: true, secret: true },
      { name: 'bucket', label: 'Bucket', type: 'text', required: true, scope: 'job' },
      { name: 'prefix', label: 'Path prefix', type: 'text', scope: 'job' },
    ],
    build: (_config, credentials, repoConfig) => ({
      repository: `b2:${str(repoConfig.bucket)}:${str(repoConfig.prefix).replace(/^\/+/, '')}`,
      env: {
        B2_ACCOUNT_ID: credentials.accountId ?? '',
        B2_ACCOUNT_KEY: credentials.accountKey ?? '',
      },
      credentialFiles: [],
    }),
  },
  {
    type: 'azure',
    label: 'Azure Blob Storage',
    fields: [
      { name: 'accountName', label: 'Account name', type: 'text', required: true },
      { name: 'accountKey', label: 'Account Key', type: 'password', secret: true },
      { name: 'sasToken', label: 'SAS token (alternative)', type: 'password', secret: true },
      { name: 'container', label: 'Container', type: 'text', required: true, scope: 'job' },
      { name: 'prefix', label: 'Path prefix', type: 'text', scope: 'job' },
    ],
    build: (config, credentials, repoConfig) => ({
      repository: `azure:${str(repoConfig.container)}:${str(repoConfig.prefix).replace(/^\/+/, '')}`,
      env: {
        AZURE_ACCOUNT_NAME: str(config.accountName),
        ...(credentials.accountKey ? { AZURE_ACCOUNT_KEY: credentials.accountKey } : {}),
        ...(credentials.sasToken ? { AZURE_ACCOUNT_SAS: credentials.sasToken } : {}),
      },
      credentialFiles: [],
    }),
  },
  {
    type: 'gs',
    label: 'Google Cloud Storage',
    fields: [
      { name: 'projectId', label: 'Project ID', type: 'text', required: true },
      { name: 'serviceAccountJson', label: 'Service account JSON', type: 'textarea', required: true, secret: true },
      { name: 'bucket', label: 'Bucket', type: 'text', required: true, scope: 'job' },
      { name: 'prefix', label: 'Path prefix', type: 'text', scope: 'job' },
    ],
    build: (config, credentials, repoConfig) => ({
      repository: `gs:${str(repoConfig.bucket)}:${str(repoConfig.prefix).replace(/^\/+/, '') || '/'}`,
      env: { GOOGLE_PROJECT_ID: str(config.projectId) },
      credentialFiles: [
        {
          envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
          filename: 'gcs-service-account.json',
          content: credentials.serviceAccountJson ?? '{}',
        },
      ],
    }),
  },
  {
    type: 'swift',
    label: 'OpenStack Swift',
    fields: [
      { name: 'authUrl', label: 'Auth URL', type: 'text', required: true, secret: true },
      { name: 'username', label: 'Username', type: 'text', secret: true },
      { name: 'password', label: 'Password', type: 'password', secret: true },
      { name: 'region', label: 'Region', type: 'text', secret: true },
      { name: 'container', label: 'Container', type: 'text', required: true, scope: 'job' },
      { name: 'prefix', label: 'Path prefix', type: 'text', scope: 'job' },
    ],
    build: (_config, credentials, repoConfig) => ({
      repository: `swift:${str(repoConfig.container)}:${str(repoConfig.prefix).replace(/^\/+/, '') || '/'}`,
      env: {
        OS_AUTH_URL: credentials.authUrl ?? '',
        OS_USERNAME: credentials.username ?? '',
        OS_PASSWORD: credentials.password ?? '',
        ...(credentials.region ? { OS_REGION_NAME: credentials.region } : {}),
      },
      credentialFiles: [],
    }),
  },
  {
    type: 'rclone',
    label: 'rclone',
    fields: [
      { name: 'remote', label: 'Remote', type: 'text', required: true, placeholder: 'myremote' },
      { name: 'path', label: 'Path', type: 'text', scope: 'job', placeholder: 'bucket/repo' },
    ],
    build: (config, _credentials, repoConfig) => {
      const remote = str(config.remote);
      const path = str(repoConfig.path).replace(/^\/+/, '');
      return {
        repository: path ? `rclone:${remote}:${path}` : `rclone:${remote}`,
        env: {},
        credentialFiles: [],
      };
    },
  },
];

export function getBackend(type: string): BackendDefinition {
  const def = BACKENDS.find((b) => b.type === type);
  if (!def) throw new Error(`Unknown backend type: ${type}`);
  return def;
}

/**
 * Field schemas exposed to the client for dynamic form generation. Standalone
 * backends (local) are included but flagged so the target editor can hide them
 * as connections — the job editor still needs their job-scoped fields (e.g. the
 * local repository path). Each field carries its `scope` so the client can
 * render target-connection fields and job-repository fields from one payload.
 */
export function backendCatalog() {
  return BACKENDS.map((b) => ({
    type: b.type,
    label: b.label,
    standalone: b.standalone ?? false,
    fields: b.fields,
  }));
}

/**
 * Splits a flat form payload into non-secret config and secret credentials,
 * considering only the fields in the requested `scope` (default 'target').
 */
export function splitConfig(
  type: string,
  values: Record<string, unknown>,
  scope: FieldScope = 'target',
): { config: Record<string, unknown>; credentials: Record<string, string> } {
  const def = getBackend(type);
  const config: Record<string, unknown> = {};
  const credentials: Record<string, string> = {};
  for (const field of def.fields) {
    if ((field.scope ?? 'target') !== scope) continue;
    const v = values[field.name];
    if (v === undefined || v === '') continue;
    if (field.secret) credentials[field.name] = String(v);
    else config[field.name] = v;
  }
  return { config, credentials };
}

/** Required job-scoped field names for a backend (used to validate repos). */
export function requiredJobFields(type: string): string[] {
  return getBackend(type)
    .fields.filter((f) => f.scope === 'job' && f.required)
    .map((f) => f.name);
}
