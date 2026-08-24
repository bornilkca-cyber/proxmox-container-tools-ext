export interface ProxmoxConnection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly realm: string;
  readonly username: string;
  readonly tokenId: string;
  readonly certificateFingerprint?: string;
}

export function isProxmoxConnection(value: unknown): value is ProxmoxConnection {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const connection = value as Record<string, unknown>;
  const requiredFields = ['id', 'name', 'baseUrl', 'realm', 'username', 'tokenId'];
  if (!requiredFields.every((field) => typeof connection[field] === 'string' && connection[field].trim() !== '')
    || (connection.certificateFingerprint !== undefined
      && (typeof connection.certificateFingerprint !== 'string' || connection.certificateFingerprint.trim() === ''))) {
    return false;
  }

  try {
    const url = new URL(connection.baseUrl as string);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (pathname === '/' || pathname === '/api2/json')
      && (connection.certificateFingerprint === undefined || isCertificateFingerprint(connection.certificateFingerprint));
  } catch {
    return false;
  }
}

function isCertificateFingerprint(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Fa-f0-9]{64}$/.test(trimmed)
    || /^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(trimmed);
}

export interface ProxmoxCredentials {
  readonly tokenSecret: string;
}

export interface ProxmoxApiResponse<T> {
  readonly data: T;
  readonly errors?: Record<string, string>;
}

export interface ClusterResource {
  readonly id: string;
  readonly type: string;
  readonly node?: string;
  readonly vmid?: number;
  readonly name?: string;
  readonly status?: string;
  readonly cpu?: number;
  readonly maxcpu?: number;
  readonly mem?: number;
  readonly maxmem?: number;
  readonly uptime?: number;
}

export interface StorageResource {
  readonly storage: string;
  readonly type: string;
  readonly content?: string;
  readonly used?: number;
  readonly avail?: number;
  readonly total?: number;
  readonly active?: number;
}

export interface SnapshotResource {
  readonly name: string;
  readonly description?: string | null;
  readonly snaptime?: number;
  readonly parent?: string | null;
  readonly vmstate?: number;
}

export interface ProxmoxTaskStatus {
  readonly status?: string;
  readonly exitstatus?: string;
}
