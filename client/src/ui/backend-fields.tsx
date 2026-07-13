import { type BackendField } from '../core/api';
import { Icon } from '../core/icons';
import { copyToClipboard } from '../core/clipboard';
import { useToast } from './toast';
import { Field } from './primitives';

/** Renders a single dynamic backend field (text/password/number/textarea/select). */
export function BackendFieldInput({
  field: f,
  value,
  onChange,
}: {
  field: BackendField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (f.type === 'textarea') {
    return (
      <textarea
        name={f.name}
        placeholder={f.placeholder ?? ''}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (f.type === 'select' && f.options) {
    return (
      <select name={f.name} value={value} onChange={(e) => onChange(e.target.value)}>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      name={f.name}
      type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
      placeholder={f.placeholder ?? ''}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Renders a labelled list of backend fields backed by a flat value map. */
export function BackendFields({
  fields,
  values,
  onChange,
}: {
  fields: BackendField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <>
      {fields.map((f) => (
        <Field key={f.name} label={f.label + (f.required ? ' *' : '')} help={f.help}>
          <BackendFieldInput
            field={f}
            value={values[f.name] ?? ''}
            onChange={(v) => onChange(f.name, v)}
          />
        </Field>
      ))}
    </>
  );
}

/** Read-only SSH public key with copy + install instructions (SFTP targets). */
export function PublicKeyBox({ publicKey }: { publicKey: string }) {
  const toast = useToast();
  return (
    <div>
      <p className="row-sub" style={{ marginBottom: 8 }}>
        Add this public key to the SFTP server (append it to the backup user's{' '}
        <code>~/.ssh/authorized_keys</code>). Then use “Test” to verify the
        connection.
      </p>
      <textarea
        readOnly
        value={publicKey}
        rows={3}
        style={{ fontFamily: 'monospace', fontSize: 12, width: '100%' }}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            const ok = await copyToClipboard(publicKey);
            toast(ok ? 'Public key copied' : 'Copy failed', ok ? 'success' : 'error');
          }}
        >
          <Icon name="copy" /> Copy public key
        </button>
      </div>
    </div>
  );
}
