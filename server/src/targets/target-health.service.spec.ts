import { probeSpecFor } from './target-health.service';

describe('target-health probeSpecFor', () => {
  it('probes SFTP via TCP on the configured host and port', () => {
    expect(probeSpecFor('sftp', { host: 'nas.example.com', port: 2222 }, {})).toEqual({
      kind: 'tcp',
      host: 'nas.example.com',
      port: 2222,
    });
  });

  it('defaults SFTP to port 22', () => {
    expect(probeSpecFor('sftp', { host: 'nas.example.com' }, {})).toEqual({
      kind: 'tcp',
      host: 'nas.example.com',
      port: 22,
    });
  });

  it('probes a REST server at its URL', () => {
    expect(probeSpecFor('rest', { url: 'https://backup.example.com/' }, {})).toEqual({
      kind: 'http',
      url: 'https://backup.example.com/',
    });
  });

  it('adds a https scheme to a bare S3 endpoint', () => {
    expect(probeSpecFor('s3', { endpoint: 's3.amazonaws.com' }, {})).toEqual({
      kind: 'http',
      url: 'https://s3.amazonaws.com',
    });
  });

  it('keeps an explicit http scheme on an endpoint', () => {
    expect(probeSpecFor('s3', { endpoint: 'http://minio:9000' }, {})).toEqual({
      kind: 'http',
      url: 'http://minio:9000',
    });
  });

  it('probes the static B2 and GCS API endpoints', () => {
    expect(probeSpecFor('b2', {}, {})).toEqual({
      kind: 'http',
      url: 'https://api.backblazeb2.com',
    });
    expect(probeSpecFor('gs', { projectId: 'p' }, {})).toEqual({
      kind: 'http',
      url: 'https://storage.googleapis.com',
    });
  });

  it('derives the Azure blob endpoint from the account name', () => {
    expect(probeSpecFor('azure', { accountName: 'mystore' }, {})).toEqual({
      kind: 'http',
      url: 'https://mystore.blob.core.windows.net',
    });
  });

  it('probes Swift at the auth URL from the credential secret', () => {
    expect(
      probeSpecFor('swift', {}, { authUrl: 'https://keystone.example.com/v3' }),
    ).toEqual({ kind: 'http', url: 'https://keystone.example.com/v3' });
  });

  it('cannot probe rclone or incomplete configs', () => {
    expect(probeSpecFor('rclone', { remote: 'myremote' }, {})).toEqual({ kind: 'none' });
    expect(probeSpecFor('sftp', {}, {})).toEqual({ kind: 'none' });
    expect(probeSpecFor('azure', {}, {})).toEqual({ kind: 'none' });
    expect(probeSpecFor('swift', {}, {})).toEqual({ kind: 'none' });
  });
});
