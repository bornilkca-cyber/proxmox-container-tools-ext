import { ClusterResource, isProxmoxConnection, ProxmoxConnection } from './proxmoxTypes';

export type GuestActionTarget = {
  connection: ProxmoxConnection;
  resource: ClusterResource & { type: 'lxc' | 'qemu'; node: string; vmid: number };
};

export type LxcShellTarget = {
  connection: ProxmoxConnection;
  resource: ClusterResource & { type: 'lxc'; node: string; vmid: number };
};

export function isGuestActionItem(item: unknown): item is GuestActionTarget {
  if (typeof item !== 'object' || item === null || !('connection' in item) || !('resource' in item)) {
    return false;
  }

  const candidate = item as { connection?: ProxmoxConnection; resource?: ClusterResource };
  return candidate.connection !== undefined && isValidTarget(candidate.connection, candidate.resource) &&
    (candidate.resource?.type === 'lxc' || candidate.resource?.type === 'qemu') &&
    candidate.resource !== undefined;
}

export function isContainerShellItem(item: unknown): item is LxcShellTarget {
  if (typeof item !== 'object' || item === null || !('connection' in item) || !('resource' in item)) {
    return false;
  }

  const candidate = item as { connection?: ProxmoxConnection; resource?: ClusterResource };
  return candidate.connection !== undefined && isValidTarget(candidate.connection, candidate.resource) &&
    candidate.resource?.type === 'lxc' &&
    candidate.resource !== undefined;
}

function isValidTarget(connection: ProxmoxConnection, resource: ClusterResource | undefined): boolean {
  return isProxmoxConnection(connection)
    && typeof resource?.node === 'string'
    && resource.node.trim() !== ''
    && typeof resource.vmid === 'number'
    && Number.isInteger(resource.vmid)
    && resource.vmid > 0;
}

export function resolveShellItem(
  item: unknown,
  selection: readonly unknown[] = []
): LxcShellTarget | undefined {
  if (isContainerShellItem(item)) {
    return item;
  }

  if (item !== undefined) {
    return undefined;
  }

  return selection.find((selectedItem) => isContainerShellItem(selectedItem));
}

export function resolveGuestActionItem(
  item: unknown,
  selection: readonly unknown[] = []
): GuestActionTarget | undefined {
  if (isGuestActionItem(item)) {
    return item;
  }

  if (item !== undefined) {
    return undefined;
  }

  return selection.find((selectedItem) => isGuestActionItem(selectedItem));
}

export function buildLxcShellUrl(target: LxcShellTarget): string {
  const shellUrl = new URL(target.connection.baseUrl);
  shellUrl.pathname = '/';
  shellUrl.searchParams.set('console', 'lxc');
  shellUrl.searchParams.set('xtermjs', '1');
  shellUrl.searchParams.set('vmid', String(target.resource.vmid));
  shellUrl.searchParams.set('node', target.resource.node);
  return shellUrl.toString();
}

// Suffixes running/stopped guest status so tree item context values can hide the start/stop action that would fail.
export function guestContextValue(type: string, status?: string): string {
  const base = type === 'qemu' ? 'proxmoxQemu' : 'proxmoxContainer';
  return status === 'running' || status === 'stopped' ? `${base}:${status}` : base;
}

export function guestActionKey(connectionId: string, type: string, vmid: number): string {
  return `${connectionId}:${type}:${vmid}`;
}

export function buildSshCommand(username: string, hostname: string): string {
  if (/[\r\n\0]/.test(username) || /[\r\n\0]/.test(hostname)) {
    throw new Error('SSH target contains unsupported control characters.');
  }
  return `ssh '${`${username}@${hostname}`.replaceAll("'", "'\\''")}'`;
}
