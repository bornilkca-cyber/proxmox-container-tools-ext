import { ClusterResource, ProxmoxApiResponse, ProxmoxConnection, ProxmoxCredentials, ProxmoxTaskStatus, SnapshotResource, StorageResource } from './proxmoxTypes';
import * as https from 'node:https';
import { X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';
import { TLSSocket } from 'node:tls';

const requestTimeoutMs = 10000;
const maxResponseBytes = 10 * 1024 * 1024;
const maxTaskWaitMs = 5 * 60 * 1000;

export class ProxmoxApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ProxmoxApiError';
  }
}

export class ProxmoxClient {
  constructor(
    private readonly connection: ProxmoxConnection,
    private readonly credentials: ProxmoxCredentials,
    private readonly timeoutMs = requestTimeoutMs
  ) {
    let url: URL;
    try {
      url = new URL(connection.baseUrl);
    } catch {
      throw new ProxmoxApiError('Proxmox connection URL is invalid.');
    }
    if (connection.baseUrl !== connection.baseUrl.trim()) {
      throw new ProxmoxApiError('Proxmox connection URL must not contain surrounding whitespace.');
    }
    if (credentials.tokenSecret.trim() === '') {
      throw new ProxmoxApiError('Proxmox API token secret is missing.');
    }
    if (url.protocol !== 'https:') {
      throw new ProxmoxApiError('Proxmox connections must use HTTPS.');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ProxmoxApiError('Proxmox connection URLs must not contain credentials, query parameters, or fragments.');
    }
    if (url.pathname !== '/' && url.pathname.replace(/\/+$/, '') !== '/api2/json') {
      throw new ProxmoxApiError('Proxmox connection URLs must use the server root or /api2/json path.');
    }
  }

  getClusterResources(signal?: AbortSignal): Promise<ClusterResource[]> {
    return this.get<ClusterResource[]>('/cluster/resources', signal).then((resources) => {
      if (!Array.isArray(resources) || !resources.every(isClusterResource)) {
        throw new ProxmoxApiError('Proxmox returned an invalid resource list.');
      }
      return resources;
    });
  }

  getStorage(node: string, signal?: AbortSignal): Promise<StorageResource[]> {
    const normalizedNode = requireNodeName(node);
    return this.get<StorageResource[]>(`/nodes/${encodeURIComponent(normalizedNode)}/storage`, signal).then((storage) => {
      if (!Array.isArray(storage)) {
        throw new ProxmoxApiError('Proxmox returned an invalid storage list.');
      }

      const normalizedStorage = storage
        .map((entry) => normalizeStorageResource(entry))
        .filter((entry): entry is StorageResource => entry !== undefined);

      return uniqueStorageByName(normalizedStorage);
    });
  }

  getSnapshots(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<SnapshotResource[]> {
    const normalizedNode = validateGuestArguments(node, vmid);
    return this.get<SnapshotResource[]>(`/nodes/${encodeURIComponent(normalizedNode)}/${type}/${vmid}/snapshot`, signal).then((snapshots) => {
      if (!Array.isArray(snapshots) || !snapshots.every(isSnapshotResource)) {
        throw new ProxmoxApiError('Proxmox returned an invalid snapshot list.');
      }
      return snapshots;
    });
  }

  startGuest(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<string> {
    const normalizedNode = validateGuestArguments(node, vmid);
    return this.post<unknown>(`/nodes/${encodeURIComponent(normalizedNode)}/${type}/${vmid}/status/start`, signal).then(requireTaskId);
  }

  stopGuest(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<string> {
    const normalizedNode = validateGuestArguments(node, vmid);
    return this.post<unknown>(`/nodes/${encodeURIComponent(normalizedNode)}/${type}/${vmid}/status/stop`, signal).then(requireTaskId);
  }

  async waitForTask(node: string, upid: string, signal?: AbortSignal, taskWaitMs = maxTaskWaitMs): Promise<void> {
    const normalizedNode = requireNodeName(node);
    const normalizedUpid = requireUpid(upid);
    if (!Number.isFinite(taskWaitMs) || taskWaitMs <= 0) {
      throw new ProxmoxApiError('Proxmox task wait deadline must be greater than zero.');
    }
    const deadline = Date.now() + taskWaitMs;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), Math.max(0, taskWaitMs));
    const abortDeadline = () => deadlineController.abort();
    signal?.addEventListener('abort', abortDeadline, { once: true });
    try {
      for (;;) {
        let status: ProxmoxTaskStatus;
        try {
          status = await this.get<ProxmoxTaskStatus>(
            `/nodes/${encodeURIComponent(normalizedNode)}/tasks/${encodeURIComponent(normalizedUpid)}/status`,
            deadlineController.signal
          );
        } catch (error) {
          if (Date.now() >= deadline && !signal?.aborted) {
            throw new ProxmoxApiError('Proxmox task polling timed out.');
          }
          throw error;
        }
      if (!isProxmoxTaskStatus(status)) {
        throw new ProxmoxApiError('Proxmox returned an invalid task status.');
      }
      if (status.status === 'stopped') {
        if (typeof status.exitstatus !== 'string') {
          throw new ProxmoxApiError('Proxmox returned an invalid task status.');
        }
        if (status.exitstatus !== 'OK') {
          throw new ProxmoxApiError(`Proxmox task failed: ${this.redact(status.exitstatus)}`);
        }
        return;
      }
      if (status.status !== 'running') {
        throw new ProxmoxApiError('Proxmox returned an invalid task status.');
      }
      if (Date.now() >= deadline) {
        throw new ProxmoxApiError('Proxmox task polling timed out.');
      }
      try {
        await delay(500, deadlineController.signal);
      } catch (error) {
        if (Date.now() >= deadline && !signal?.aborted) {
          throw new ProxmoxApiError('Proxmox task polling timed out.');
        }
        throw error;
      }
      }
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', abortDeadline);
    }
  }

  private post<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('POST', path, signal);
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, signal);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new ProxmoxApiError('The Proxmox request was cancelled.');
    }
    const requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), this.timeoutMs);
    const abortRequest = () => requestController.abort();
    signal?.addEventListener('abort', abortRequest, { once: true });

    let response: Response | undefined;
    try {
      try {
        response = this.connection.certificateFingerprint === undefined
          ? await fetch(`${this.apiBaseUrl()}${path}`, {
            method,
            headers: {
              Accept: 'application/json',
              Authorization: this.authorizationHeader()
            },
            signal: requestController.signal
          })
          : await this.getWithPinnedCertificate(`${this.apiBaseUrl()}${path}`, requestController.signal, method);
      } catch (error) {
        if (requestController.signal.aborted) {
          if (signal?.aborted) {
            throw error;
          }
          throw new ProxmoxApiError('The Proxmox request timed out.');
        }
        if (isCertificateError(error)) {
          throw new ProxmoxApiError('The Proxmox server certificate is not trusted. Trust its issuing CA on the VS Code host, then retry.');
        }
        if (error instanceof ProxmoxApiError) {
          throw error;
        }
        throw new ProxmoxApiError('Unable to connect to the Proxmox server.');
      }

      let body: unknown;
      try {
        body = await readResponseBody(response);
      } catch (error) {
        if (error instanceof ProxmoxApiError) {
          throw error;
        }
        if (!response.ok) {
          throw new ProxmoxApiError(`Proxmox request failed: ${response.statusText}`, response.status);
        }
        throw new ProxmoxApiError(`Proxmox returned an invalid response (${response.status}).`, response.status);
      }
      if (!isRecord(body)) {
        throw new ProxmoxApiError(`Proxmox returned an invalid response (${response.status}).`, response.status);
      }

      const apiBody = body as unknown as ProxmoxApiResponse<T>;
      if (!response.ok || ('errors' in apiBody && apiBody.errors !== undefined) || !('data' in apiBody)) {
        if ('errors' in apiBody && apiBody.errors !== undefined && !isRecord(apiBody.errors)) {
          throw new ProxmoxApiError('Proxmox returned an invalid API error envelope.', response.status);
        }
        const detail = apiBody.errors ? this.redact(formatApiErrors(apiBody.errors)) : response.statusText;
        throw new ProxmoxApiError(`Proxmox request failed: ${detail}`, response.status);
      }

      return apiBody.data;
    } catch (error) {
      if (signal?.aborted) {
        throw new ProxmoxApiError('The Proxmox request was cancelled.');
      }
      if (requestController.signal.aborted && !signal?.aborted) {
        throw new ProxmoxApiError('The Proxmox request timed out.');
      }
      if (error instanceof ProxmoxApiError) {
        throw error;
      }
      throw new ProxmoxApiError(`Proxmox returned an invalid response (${response?.status ?? 'unknown'}).`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortRequest);
    }
  }

  private authorizationHeader(): string {
    return `PVEAPIToken=${this.connection.username}@${this.connection.realm}!${this.connection.tokenId}=${this.credentials.tokenSecret}`;
  }

  private apiBaseUrl(): string {
    const baseUrl = this.connection.baseUrl.replace(/\/+$/, '');
    return baseUrl.endsWith('/api2/json') ? baseUrl : `${baseUrl}/api2/json`;
  }

  private redact(value: string): string {
    return value.replaceAll(this.credentials.tokenSecret, '[REDACTED]');
  }

  private getWithPinnedCertificate(url: string, signal: AbortSignal, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: TLSSocket | undefined;
      const trustedFingerprint = normalizeCertificateFingerprint(this.connection.certificateFingerprint);
      if (trustedFingerprint === undefined) {
        reject(new ProxmoxApiError('The trusted Proxmox certificate fingerprint is invalid. Trust the server certificate again.'));
        return;
      }
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', abort);
        callback();
      };
      const abort = () => {
        socket?.destroy(new Error('aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      const parsedUrl = new URL(url);
      socket = tls.connect({
        host: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        servername: parsedUrl.hostname,
        // Disables TLS session resumption so the server always sends its full certificate to verify.
        rejectUnauthorized: false
      });
      socket.once('secureConnect', () => {
        const peerFingerprint = peerCertificateFingerprint(socket?.getPeerCertificate(true));
        if (peerFingerprint === undefined) {
          socket?.destroy();
          finish(() => reject(new ProxmoxApiError('The Proxmox server did not provide a valid certificate fingerprint. Trust the server certificate again.')));
          return;
        }
        if (peerFingerprint !== trustedFingerprint) {
          socket?.destroy();
          finish(() => reject(new ProxmoxApiError('The Proxmox server certificate does not match the certificate trusted for this connection. Trust the current certificate again only if you verified the new SHA-256 fingerprint out of band.')));
          return;
        }
        const responseChunks: Buffer[] = [];
        let responseBytes = 0;
        socket?.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > maxResponseBytes) {
            socket?.destroy(new ProxmoxApiError('The Proxmox response exceeded the maximum supported size.'));
            return;
          }
          responseChunks.push(chunk);
        });
        socket?.once('error', (error) => finish(() => reject(error)));
        socket?.once('end', () => {
          try {
            const response = parsePinnedResponse(Buffer.concat(responseChunks));
            finish(() => resolve(response));
          } catch (error) {
            finish(() => reject(error));
          }
        });
        socket?.write(`${method} ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1\r\nHost: ${parsedUrl.host}\r\nAccept: application/json\r\nAuthorization: ${this.authorizationHeader()}\r\nConnection: close\r\n\r\n`);
      });
      socket.on('error', (error) => finish(() => reject(error)));
    });
  }
}

function parsePinnedResponse(payload: Buffer): Response {
  const separator = payload.indexOf('\r\n\r\n');
  if (separator < 0) {
    throw new ProxmoxApiError('Proxmox returned an invalid response.');
  }
  const headerText = payload.subarray(0, separator).toString('latin1');
  const statusMatch = /^HTTP\/\d\.\d (\d{3})(?: ([^\r\n]*))?$/m.exec(headerText);
  if (statusMatch === null) {
    throw new ProxmoxApiError('Proxmox returned an invalid response.');
  }
  const status = Number(statusMatch[1]);
  const statusText = statusMatch[2] ?? '';
  const headers = new Map(headerText.split('\r\n').slice(1).map((line) => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
  }));
  let body = payload.subarray(separator + 4);
  if (headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
    body = decodeChunkedBody(body);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => JSON.parse(body.toString('utf8'))
  } as Response;
}

function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) {
      throw new ProxmoxApiError('Proxmox returned an invalid response.');
    }
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0], 16);
    if (!Number.isFinite(size) || size < 0 || lineEnd + 2 + size + 2 > body.length) {
      throw new ProxmoxApiError('Proxmox returned an invalid response.');
    }
    if (size === 0) {
      break;
    }
    chunks.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(chunks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isClusterResource(value: unknown): value is ClusterResource {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.trim() !== ''
    && typeof value.type === 'string'
    && value.type.trim() !== ''
    && (value.node === undefined || (typeof value.node === 'string' && value.node.trim() !== ''))
    && (value.name === undefined || (typeof value.name === 'string' && value.name.trim() !== ''))
    && (value.status === undefined || typeof value.status === 'string')
    && hasValidNumericFields(value, ['maxcpu', 'mem', 'maxmem', 'uptime'])
    && (value.vmid === undefined || isValidVmid(value.vmid))
    && (value.cpu === undefined || isValidCpuRatio(value.cpu));
}

function isStorageResource(value: unknown): value is StorageResource {
  return isRecord(value)
    && typeof value.storage === 'string'
    && value.storage.trim() !== ''
    && typeof value.type === 'string'
    && value.type.trim() !== ''
    && hasValidNumericFields(value, ['used', 'avail', 'total', 'active']);
}

function normalizeStorageResource(value: unknown): StorageResource | undefined {
  if (!isRecord(value) || typeof value.storage !== 'string' || value.storage.trim() === '') {
    return undefined;
  }

  const used = normalizeOptionalNonNegativeNumber(value.used);
  const avail = normalizeOptionalNonNegativeNumber(value.avail);
  const total = normalizeOptionalNonNegativeNumber(value.total);
  const active = normalizeOptionalActiveFlag(value.active);

  return {
    storage: value.storage.trim(),
    type: typeof value.type === 'string' && value.type.trim() !== '' ? value.type.trim() : 'unknown',
    content: normalizeStorageContent(value.content),
    used,
    avail,
    total,
    active
  };
}

function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  if (typeof value === 'string') {
    if (value.trim() === '') {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  return undefined;
}

function normalizeOptionalActiveFlag(value: unknown): number | undefined {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const active = normalizeOptionalNonNegativeNumber(value);
  return active === 0 || active === 1 ? active : undefined;
}

function normalizeStorageContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value.trim();
  }
  if (Array.isArray(value)) {
    const content = uniqueStrings(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim()))
      .join(', ');
    return content === '' ? undefined : content;
  }
  return undefined;
}

function uniqueStorageByName(storage: readonly StorageResource[]): StorageResource[] {
  const unique = new Map<string, StorageResource>();
  for (const entry of storage) {
    unique.set(entry.storage, entry);
  }
  return [...unique.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isSnapshotResource(value: unknown): value is SnapshotResource {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.trim() !== ''
    && (value.vmstate === undefined || value.vmstate === 0 || value.vmstate === 1)
    && (value.snaptime === undefined
      || (typeof value.snaptime === 'number' && Number.isFinite(value.snaptime) && value.snaptime > 0))
    && (value.description === undefined || value.description === null || typeof value.description === 'string')
    && (value.parent === undefined || value.parent === null || typeof value.parent === 'string');
}

function hasValidNumericFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => value[field] === undefined
    || (typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0));
}

function isValidCpuRatio(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidVmid(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateGuestArguments(node: string, vmid: number): string {
  const normalizedNode = requireNodeName(node);
  if (!isValidVmid(vmid)) {
    throw new ProxmoxApiError('Proxmox VMID must be a positive integer.');
  }
  return normalizedNode;
}

function requireNodeName(node: string): string {
  if (typeof node !== 'string' || node.trim() === '') {
    throw new ProxmoxApiError('Proxmox node name is missing.');
  }
  return node.trim();
}

function requireUpid(upid: string): string {
  if (typeof upid !== 'string' || upid.trim() === '') {
    throw new ProxmoxApiError('Proxmox task identifier is missing.');
  }
  return upid.trim();
}

function isProxmoxTaskStatus(value: unknown): value is ProxmoxTaskStatus {
  return isRecord(value) && typeof value.status === 'string';
}

function requireTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProxmoxApiError('Proxmox returned an invalid task ID.');
  }
  return value.trim();
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (!response.body) {
    return response.json();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      responseBytes += value.byteLength;
      if (responseBytes > maxResponseBytes) {
        throw new ProxmoxApiError('The Proxmox response exceeded the maximum supported size.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder().decode(concatChunks(chunks, responseBytes)));
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('The Proxmox request was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function formatApiErrors(errors: unknown): string {
  if (!isRecord(errors)) {
    if (errors === null || errors === undefined) {
      return 'The Proxmox server returned an API error.';
    }
    return `The Proxmox server returned an API error: ${String(errors)}`;
  }

  const messages = Object.values(errors).map((value) => {
    if (typeof value === 'string') {
      return value;
    }
    if (value === null || value === undefined) {
      return '';
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).filter((value) => value !== '');
  return messages.length === 0 ? 'The Proxmox server returned an API error.' : messages.join('; ');
}

function isCertificateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = (error as Error & { code?: unknown }).code;
  if (typeof errorCode === 'string') {
    const code = errorCode;
    return code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      || code === 'SELF_SIGNED_CERT_IN_CHAIN'
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT';
  }

  const cause = error.cause;
  return isRecord(cause) && typeof cause.code === 'string' && (
    cause.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    cause.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    cause.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  );
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

