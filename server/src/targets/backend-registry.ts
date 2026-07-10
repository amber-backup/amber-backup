/**
 * Registry of supported restic backends (§6). Each definition declares its
 * config field schema (used to generate the client form), how to build the
 * restic repository string, and which environment variables / credential files
 * a restic invocation needs. Adding a backend = one new entry, no core change.
 */

export type FieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'textarea'
  | 'select';

export interface BackendField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Secret fields are stored encrypted in the credential secret. */
  secret?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface CredentialFile {
  /** Env var that should point at the written file (e.g. GOOGLE_APPLICATION_CREDENTIALS). */
  envVar: string;
  filename: string;
  content: string;
}

export interface ResolvedBackend {
  repository: string;
  env: Record<string, string>;
  credentialFiles: CredentialFile[];
}

export interface BackendDefinition {
  type: string;
  label: string;
  fields: BackendField[];
  build(
    config: Record<string, unknown>,
    credentials: Record<string, string>,
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
    fields: [
      {
        name: 'path',
        label: 'Path',
        type: 'text',
        required: true,
        placeholder: '/srv/restic-repo',
      },
    ],
    build: (config) => ({
      repository: str(config.path),
      env: {},
      credentialFiles: [],
    }),
  },
  {
    type: 'sftp',
    label: 'SFTP',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true },
      { name: 'user', label: 'User', type: 'text', required: true },
      { name: 'path', label: 'Path', type: 'text', required: true, placeholder: '/backups/restic' },
      { name: 'port', label: 'Port', type: 'number', placeholder: '22' },
    ],
    build: (config) => {
      const host = str(config.host);
      const user = str(config.user);
      const path = str(config.path);
      return {
        repository: `sftp:${user}@${host}:${path}`,
        env: {},
        credentialFiles: [],
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
      { name: 'bucket', label: 'Bucket', type: 'text', required: true },
      { name: 'prefix', label: 'Path prefix', type: 'text' },
      { name: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1' },
      { name: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true, secret: true },
      { name: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true, secret: true },
    ],
    build: (config, credentials) => ({
      repository: `s3:${joinPath(`${str(config.endpoint)}/${str(config.bucket)}`, config.prefix)}`,
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
      { name: 'bucket', label: 'Bucket', type: 'text', required: true },
      { name: 'prefix', label: 'Path prefix', type: 'text' },
      { name: 'accountId', label: 'Account ID / Key ID', type: 'text', required: true, secret: true },
      { name: 'accountKey', label: 'Application Key', type: 'password', required: true, secret: true },
    ],
    build: (config, credentials) => ({
      repository: `b2:${str(config.bucket)}:${str(config.prefix).replace(/^\/+/, '')}`,
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
      { name: 'container', label: 'Container', type: 'text', required: true },
      { name: 'prefix', label: 'Path prefix', type: 'text' },
      { name: 'accountKey', label: 'Account Key', type: 'password', secret: true },
      { name: 'sasToken', label: 'SAS token (alternative)', type: 'password', secret: true },
    ],
    build: (config, credentials) => ({
      repository: `azure:${str(config.container)}:${str(config.prefix).replace(/^\/+/, '')}`,
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
      { name: 'bucket', label: 'Bucket', type: 'text', required: true },
      { name: 'prefix', label: 'Path prefix', type: 'text' },
      { name: 'projectId', label: 'Project ID', type: 'text', required: true },
      { name: 'serviceAccountJson', label: 'Service account JSON', type: 'textarea', required: true, secret: true },
    ],
    build: (config, credentials) => ({
      repository: `gs:${str(config.bucket)}:${str(config.prefix).replace(/^\/+/, '') || '/'}`,
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
      { name: 'container', label: 'Container', type: 'text', required: true },
      { name: 'prefix', label: 'Path prefix', type: 'text' },
      { name: 'authUrl', label: 'Auth URL', type: 'text', required: true, secret: true },
      { name: 'username', label: 'Username', type: 'text', secret: true },
      { name: 'password', label: 'Password', type: 'password', secret: true },
      { name: 'region', label: 'Region', type: 'text', secret: true },
    ],
    build: (config, credentials) => ({
      repository: `swift:${str(config.container)}:${str(config.prefix).replace(/^\/+/, '') || '/'}`,
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
      { name: 'remote', label: 'Remote:path', type: 'text', required: true, placeholder: 'myremote:bucket/path' },
    ],
    build: (config) => ({
      repository: `rclone:${str(config.remote)}`,
      env: {},
      credentialFiles: [],
    }),
  },
];

export function getBackend(type: string): BackendDefinition {
  const def = BACKENDS.find((b) => b.type === type);
  if (!def) throw new Error(`Unknown backend type: ${type}`);
  return def;
}

/** Field schemas exposed to the client for dynamic form generation. */
export function backendCatalog() {
  return BACKENDS.map((b) => ({
    type: b.type,
    label: b.label,
    fields: b.fields,
  }));
}

/** Splits a flat form payload into non-secret config and secret credentials. */
export function splitConfig(
  type: string,
  values: Record<string, unknown>,
): { config: Record<string, unknown>; credentials: Record<string, string> } {
  const def = getBackend(type);
  const config: Record<string, unknown> = {};
  const credentials: Record<string, string> = {};
  for (const field of def.fields) {
    const v = values[field.name];
    if (v === undefined || v === '') continue;
    if (field.secret) credentials[field.name] = String(v);
    else config[field.name] = v;
  }
  return { config, credentials };
}
