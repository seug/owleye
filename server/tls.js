/**
 * Self-signed certificate helper.
 *
 * Why this exists: getUserMedia and the Screen Wake Lock API only work in a
 * secure context. `http://localhost` counts as one, so the Mac itself is fine
 * over plain HTTP — but a phone hitting http://192.168.x.x does not, and the
 * browser will refuse the camera. So phone support means HTTPS, and for a LAN
 * pilot that means a self-signed cert with the machine's LAN IPs in subjectAltName.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/**
 * Return {key, cert} PEM buffers.
 *
 * A real certificate (`OWLEYE_TLS_KEY` / `OWLEYE_TLS_CERT`) wins; otherwise a
 * self-signed pair is generated once and reused.
 */
export function ensureCertificate(certDir, { tlsKey = '', tlsCert = '' } = {}) {
  if (tlsKey || tlsCert) {
    if (!tlsKey || !tlsCert) {
      throw new Error('set both OWLEYE_TLS_KEY and OWLEYE_TLS_CERT, or neither');
    }
    for (const [label, file] of [['OWLEYE_TLS_KEY', tlsKey], ['OWLEYE_TLS_CERT', tlsCert]]) {
      if (!existsSync(file)) throw new Error(`${label} points at a missing file: ${file}`);
    }
    return { key: readFileSync(tlsKey), cert: readFileSync(tlsCert), path: tlsCert, generated: false, provided: true };
  }

  const keyPath = join(certDir, 'owleye-key.pem');
  const certPath = join(certDir, 'owleye-cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath), path: certPath, generated: false };
  }

  mkdirSync(certDir, { recursive: true });

  const ips = localAddresses();
  const san = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  const confPath = join(certDir, 'openssl.cnf');
  writeFileSync(
    confPath,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3',
      'prompt = no',
      '',
      '[dn]',
      'CN = owleye.local',
      '',
      '[v3]',
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = ${san}`,
      '',
    ].join('\n'),
  );

  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath,
        '-out', certPath,
        '-days', '365',
        '-config', confPath,
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new Error(`openssl failed to generate a certificate: ${detail}`);
  }

  return { key: readFileSync(keyPath), cert: readFileSync(certPath), path: certPath, generated: true, san };
}
