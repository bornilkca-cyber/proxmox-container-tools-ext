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

/**
 * Callback for polling progress updates during long-running operations like guest start/stop.
 * Called when polling begins, completes, or fails.
 *
 * @param phase - Current phase: 'polling' (in progress), 'stopped' (success), or 'failed' (error)
 * @param progress - Optional progress indicator (0-100) for UI display
 */
export type PollingProgressCallback = (phase: 'polling' | 'stopped' | 'failed', progress?: number) => void;

/**
 * Configuration for adaptive polling behavior during guest operations.
 * Allows customization of polling intervals and timeouts for different scenarios.
 */
export interface PollingConfig {
  /** Initial polling interval in milliseconds (default: 500) */
  readonly initialIntervalMs?: number;

  /** Maximum polling interval with exponential backoff in milliseconds (default: 30000) */
  readonly maxIntervalMs?: number;

  /** Specific polling interval for container operations in milliseconds (default: 3000) */
  readonly containerIntervalMs?: number;

  /** Maximum total polling duration in milliseconds (default: 300000 = 5 minutes) */
  readonly maxWaitMs?: number;
}

/**
 * Detailed configuration information for a guest (QEMU VM or LXC container).
 * Fetched from the Proxmox API /nodes/{node}/{type}/{vmid}/config endpoint.
 */
export interface GuestDetailInfo {
  readonly vmid: number;
  readonly node: string;
  readonly type: 'qemu' | 'lxc';
  readonly name?: string;
  readonly status?: string;

  // CPU configuration
  readonly cores?: number;
  readonly cpulimit?: number;
  readonly cpuunits?: number;

  // Memory configuration (in bytes)
  readonly memory?: number;
  readonly balloon?: number;

  // Storage configuration
  readonly rootfs?: string;
  readonly sata?: Record<string, unknown>;
  readonly virtio?: Record<string, unknown>;
  readonly ide?: Record<string, unknown>;
  readonly scsi?: Record<string, unknown>;

  // Boot configuration
  readonly boot?: string;
  readonly bootdisk?: string;

  // Network configuration
  readonly net?: Record<string, unknown>;

  // Container-specific options
  readonly ostype?: string;
  readonly osrelease?: string;
  readonly hostname?: string;
  readonly tags?: string;

  // General options
  readonly onboot?: number; // 0 or 1
  readonly autostart?: number; // 0 or 1
  readonly protection?: number; // 0 or 1
  readonly lock?: string;
  readonly description?: string;

  // Uptime and status
  readonly uptime?: number;
}
