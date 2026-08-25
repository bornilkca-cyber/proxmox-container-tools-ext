import * as https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { TLSSocket } from 'node:tls';

export function readCertificateFingerprint(baseUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return Promise.reject(new Error('The Proxmox server URL is invalid.'));
  }

  if (url.protocol !== 'https:') {
    return Promise.reject(new Error('The Proxmox server URL must use HTTPS.'));
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/api2/json')
    ? `${pathname}/version`
    : `${pathname}/api2/json/version`;

  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent: false, rejectUnauthorized: false }, (response) => {
      response.on('error', reject);
      const socket = response.socket;
      const certificate = socket !== undefined && typeof (socket as TLSSocket & { getPeerCertificate?: () => PeerCertificate }).getPeerCertificate === 'function'
        ? (socket as TLSSocket & { getPeerCertificate: () => PeerCertificate }).getPeerCertificate(true)
        : undefined;
      const fingerprint = peerCertificateFingerprint(certificate);
      response.resume();
      if (fingerprint === undefined) {
        reject(new Error('The Proxmox server did not provide a valid certificate fingerprint.'));
        return;
      }
      resolve(fingerprint);
    });
    request.setTimeout(10000, () => request.destroy(new Error('Certificate request timed out.')));
    request.on('error', reject);
  });
}

type PeerCertificate = {
  readonly fingerprint256?: string;
  readonly raw?: Buffer;
};

function peerCertificateFingerprint(certificate: PeerCertificate | undefined): string | undefined {
  if (certificate === undefined) {
    return undefined;
  }

  const normalized = normalizeCertificateFingerprint(certificate.fingerprint256);
  if (normalized !== undefined) {
    return normalized;
  }

  return Buffer.isBuffer(certificate.raw)
    ? normalizeCertificateFingerprint(new X509Certificate(certificate.raw).fingerprint256)
    : undefined;
}

function normalizeCertificateFingerprint(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const hex = value.replaceAll(':', '').replaceAll(/\s/g, '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(hex)) {
    return undefined;
  }
  return hex.match(/../g)?.join(':');
}
