import * as nodemailer from 'nodemailer';

/**
 * Registry of supported notification providers. Each definition declares its
 * config field schema (used to generate the client form) and how to deliver a
 * message. Secret fields are stored encrypted; non-secret fields live in the
 * channel's `config`. Adding a provider = one new entry, no core change.
 *
 * Mirrors the backend registry pattern used for restic targets (§6).
 */

export type FieldType = 'text' | 'password' | 'number' | 'textarea' | 'select';

export interface ChannelField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Secret fields are stored encrypted in the channel credential secret. */
  secret?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

/** The rendered event a channel delivers. */
export interface NotificationMessage {
  status: 'success' | 'failed';
  /** Short one-line title, e.g. "✅ Backup succeeded: Nightly home". */
  title: string;
  /** Plain-text body with details. */
  body: string;
  /** Job name for providers that separate subject/body. */
  jobName: string;
  /** Link back to the Amber dashboard. */
  url: string;
}

export interface ChannelDefinition {
  type: string;
  label: string;
  fields: ChannelField[];
  /** Delivers the message. Throws on failure. */
  send(
    config: Record<string, unknown>,
    secrets: Record<string, string>,
    message: NotificationMessage,
  ): Promise<void>;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** POSTs JSON to a URL and throws if the response is not 2xx. */
async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
}

const COLOR_OK = '4FB98A';
const COLOR_FAIL = 'E8756E';

export const CHANNELS: ChannelDefinition[] = [
  {
    type: 'email',
    label: 'Email (SMTP)',
    fields: [
      { name: 'host', label: 'SMTP host', type: 'text', required: true, placeholder: 'smtp.example.com' },
      { name: 'port', label: 'Port', type: 'number', required: true, placeholder: '587' },
      {
        name: 'security',
        label: 'Security',
        type: 'select',
        options: [
          { value: 'starttls', label: 'STARTTLS (587)' },
          { value: 'tls', label: 'TLS/SSL (465)' },
          { value: 'none', label: 'None' },
        ],
      },
      { name: 'from', label: 'From address', type: 'text', required: true, placeholder: 'amber@example.com' },
      { name: 'to', label: 'To address', type: 'text', required: true, placeholder: 'ops@example.com' },
      { name: 'username', label: 'Username', type: 'text', secret: true },
      { name: 'password', label: 'Password', type: 'password', secret: true },
    ],
    send: async (config, secrets, message) => {
      const port = Number(str(config.port)) || 587;
      const security = str(config.security) || 'starttls';
      const transport = nodemailer.createTransport({
        host: str(config.host),
        port,
        secure: security === 'tls',
        requireTLS: security === 'starttls',
        auth: secrets.username
          ? { user: secrets.username, pass: secrets.password ?? '' }
          : undefined,
      });
      await transport.sendMail({
        from: str(config.from),
        to: str(config.to),
        subject: message.title,
        text: `${message.body}\n\n${message.url}`,
      });
    },
  },
  {
    type: 'webhook',
    label: 'Generic webhook',
    fields: [
      { name: 'url', label: 'Webhook URL', type: 'text', required: true, secret: true, placeholder: 'https://…' },
      {
        name: 'headerName',
        label: 'Auth header name',
        type: 'text',
        placeholder: 'Authorization',
        help: 'Optional custom header sent with each request.',
      },
      { name: 'headerValue', label: 'Auth header value', type: 'password', secret: true },
    ],
    send: async (config, secrets, message) => {
      const headers: Record<string, string> = {};
      const name = str(config.headerName);
      if (name && secrets.headerValue) headers[name] = secrets.headerValue;
      await postJson(
        secrets.url,
        {
          status: message.status,
          title: message.title,
          text: message.body,
          job: message.jobName,
          url: message.url,
        },
        headers,
      );
    },
  },
  {
    type: 'slack',
    label: 'Slack',
    fields: [
      {
        name: 'webhookUrl',
        label: 'Incoming webhook URL',
        type: 'text',
        required: true,
        secret: true,
        placeholder: 'https://hooks.slack.com/services/…',
      },
    ],
    send: async (_config, secrets, message) => {
      const emoji = message.status === 'success' ? ':white_check_mark:' : ':x:';
      await postJson(secrets.webhookUrl, {
        text: `${emoji} *${message.title}*\n${message.body}\n<${message.url}|Open Amber Backup>`,
      });
    },
  },
  {
    type: 'teams',
    label: 'Microsoft Teams',
    fields: [
      {
        name: 'webhookUrl',
        label: 'Incoming webhook URL',
        type: 'text',
        required: true,
        secret: true,
        placeholder: 'https://…webhook.office.com/…',
      },
    ],
    send: async (_config, secrets, message) => {
      await postJson(secrets.webhookUrl, {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        themeColor: message.status === 'success' ? COLOR_OK : COLOR_FAIL,
        summary: message.title,
        title: message.title,
        text: message.body.replace(/\n/g, '\n\n'),
        potentialAction: [
          {
            '@type': 'OpenUri',
            name: 'Open Amber Backup',
            targets: [{ os: 'default', uri: message.url }],
          },
        ],
      });
    },
  },
  {
    type: 'discord',
    label: 'Discord',
    fields: [
      {
        name: 'webhookUrl',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        secret: true,
        placeholder: 'https://discord.com/api/webhooks/…',
      },
    ],
    send: async (_config, secrets, message) => {
      await postJson(secrets.webhookUrl, {
        embeds: [
          {
            title: message.title,
            description: `${message.body}\n\n[Open Amber Backup](${message.url})`,
            color: parseInt(message.status === 'success' ? COLOR_OK : COLOR_FAIL, 16),
          },
        ],
      });
    },
  },
  {
    type: 'telegram',
    label: 'Telegram',
    fields: [
      { name: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true },
      {
        name: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: '123456789',
        help: 'Numeric user or group chat id (talk to @userinfobot).',
      },
    ],
    send: async (config, secrets, message) => {
      await postJson(`https://api.telegram.org/bot${secrets.botToken}/sendMessage`, {
        chat_id: str(config.chatId),
        text: `${message.title}\n${message.body}\n${message.url}`,
        disable_web_page_preview: true,
      });
    },
  },
  {
    type: 'gotify',
    label: 'Gotify',
    fields: [
      { name: 'serverUrl', label: 'Server URL', type: 'text', required: true, placeholder: 'https://gotify.example.com' },
      { name: 'appToken', label: 'App token', type: 'password', required: true, secret: true },
    ],
    send: async (config, secrets, message) => {
      const base = str(config.serverUrl).replace(/\/$/, '');
      await postJson(`${base}/message?token=${encodeURIComponent(secrets.appToken)}`, {
        title: message.title,
        message: `${message.body}\n\n${message.url}`,
        priority: message.status === 'success' ? 4 : 8,
      });
    },
  },
];

export function getChannel(type: string): ChannelDefinition {
  const def = CHANNELS.find((c) => c.type === type);
  if (!def) throw new Error(`Unknown notification channel type: ${type}`);
  return def;
}

/** Field schemas exposed to the client for dynamic form generation. */
export function channelCatalog() {
  return CHANNELS.map((c) => ({ type: c.type, label: c.label, fields: c.fields }));
}

/** Splits a flat form payload into non-secret config and secret credentials. */
export function splitChannelConfig(
  type: string,
  values: Record<string, unknown>,
): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const def = getChannel(type);
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const field of def.fields) {
    const v = values[field.name];
    if (v === undefined || v === '') continue;
    if (field.secret) secrets[field.name] = String(v);
    else config[field.name] = v;
  }
  return { config, secrets };
}
