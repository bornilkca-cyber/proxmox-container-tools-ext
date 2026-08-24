import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { ProxmoxService } from './proxmoxService';
import { ClusterResource, ProxmoxConnection, SnapshotResource, StorageResource } from './proxmoxTypes';
import { guestActionKey, guestContextValue } from './shellAccess';

type ProxmoxItem = ConnectionItem | NodeItem | GuestItem | SnapshotItem | StorageItem | MessageItem;
const inventoryRefreshIntervalMs = 60_000;
type ResourceRequestState = {
  version: number;
  request: Promise<{ guests: readonly ClusterResource[]; nodes: readonly string[] }>;
};
type StorageRequestState = {
  version: number;
  request: Promise<readonly StorageResource[]>;
};
type SnapshotRequestState = {
  version: number;
  request: Promise<readonly SnapshotResource[]>;
};

class ConnectionItem extends vscode.TreeItem {
  constructor(readonly connection: ProxmoxConnection) {
    super(connection.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = connection.id;
    const trusted = connection.certificateFingerprint !== undefined;
    this.iconPath = trusted
      ? new vscode.ThemeIcon('verified', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('server-environment', new vscode.ThemeColor('charts.yellow'));
    this.description = connection.baseUrl;
    this.contextValue = trusted ? 'proxmoxConnectionTrusted' : 'proxmoxConnectionUntrusted';
    this.tooltip = `${connection.username}@${connection.realm}\nCertificate: ${trusted ? 'trusted' : 'not trusted'}`;
    this.accessibilityInformation = {
      label: `${connection.name}, Proxmox connection, certificate ${trusted ? 'trusted' : 'not trusted'}`,
      role: 'treeitem'
    };
  }
}

class NodeItem extends vscode.TreeItem {
  constructor(
    readonly connection: ProxmoxConnection,
    readonly node: string,
    readonly resources: readonly ClusterResource[]
  ) {
    super(node, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = treeItemId('node', connection.id, node);
    this.iconPath = new vscode.ThemeIcon('server');
    this.contextValue = 'proxmoxNode';
    this.description = nodeGuestSummary(resources);
    this.accessibilityInformation = { label: `${node}, ${this.description}`, role: 'treeitem' };
  }
}

class StorageItem extends vscode.TreeItem {
  constructor(readonly connectionId: string, readonly node: string, readonly storage: StorageResource) {
    super(storage.storage, vscode.TreeItemCollapsibleState.None);
    this.id = treeItemId('storage', connectionId, node, storage.storage);
    this.iconPath = new vscode.ThemeIcon('database');
    this.contextValue = 'proxmoxStorage';
    this.description = storageSummary(storage);
    this.tooltip = formatStorageTooltip(storage);
    this.accessibilityInformation = { label: `${storage.storage}, ${storage.type} storage`, role: 'treeitem' };
  }
}

class SnapshotItem extends vscode.TreeItem {
  constructor(readonly snapshot: SnapshotResource, id: string) {
    super(snapshot.name, vscode.TreeItemCollapsibleState.None);
    this.id = id;
    this.iconPath = new vscode.ThemeIcon('history');
    this.contextValue = 'proxmoxSnapshot';
    this.description = formatSnapshotDescription(snapshot);
    this.tooltip = formatSnapshotTooltip(snapshot);
    this.accessibilityInformation = {
      label: `${snapshot.name}${this.description === undefined ? '' : `, ${this.description}`}`,
      role: 'treeitem'
    };
  }
}

class GuestItem extends vscode.TreeItem {
  readonly resource: ClusterResource;

  constructor(
    readonly connection: ProxmoxConnection,
    resource: ClusterResource,
    inFlightGuestActions: ReadonlySet<string>
  ) {
    const label = resource.name ?? `${resource.type} ${resource.vmid ?? ''}`.trim();
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.resource = resource;
    this.id = treeItemId('guest', connection.id, resource.id);
    const busy = resource.vmid !== undefined
      && inFlightGuestActions.has(guestActionKey(connection.id, resource.type, resource.vmid));
    this.iconPath = guestIcon(resource.type, busy ? 'starting' : resource.status);
    this.contextValue = busy ? `${resource.type === 'qemu' ? 'proxmoxQemu' : 'proxmoxContainer'}:busy`
      : guestContextValue(resource.type, resource.status);
    this.description = [busy ? 'Operation in progress' : guestCpuSummary(resource), resource.vmid === undefined ? undefined : `VMID ${resource.vmid}`]
      .filter(Boolean)
      .join(' | ');
    this.tooltip = formatGuestTooltip(resource);
    const accessibleStatus = busy ? 'Operation in progress' : resource.status;
    this.accessibilityInformation = {
      label: `${label}${accessibleStatus === undefined ? '' : `, ${accessibleStatus}`}`,
      role: 'treeitem'
    };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string, actionable = false) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'proxmoxMessage';
    this.accessibilityInformation = { label: message, role: 'treeitem' };
    if (actionable) {
      this.command = {
        command: 'proxmox.addConnection',
        title: 'Add Proxmox Connection'
      };
    }
  }
}

export class ProxmoxExplorerProvider implements vscode.TreeDataProvider<ProxmoxItem>, vscode.Disposable {
  private readonly refreshEvent = new vscode.EventEmitter<void>();
  private readonly resourceCache = new Map<string, { guests: readonly ClusterResource[]; nodes: readonly string[] }>();
  private readonly resourceRequests = new Map<string, ResourceRequestState>();
  private readonly resourceRequestVersions = new Map<string, number>();
  private readonly storageCache = new Map<string, readonly StorageResource[]>();
  private readonly storageRequests = new Map<string, StorageRequestState>();
  private readonly snapshotCache = new Map<string, readonly SnapshotResource[]>();
  private readonly snapshotRequests = new Map<string, SnapshotRequestState>();
  private readonly inventoryRefreshTimer: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly connectionStore: ConnectionStore,
    private readonly inFlightGuestActions: ReadonlySet<string>
  ) {
    this.inventoryRefreshTimer = setInterval(() => this.refresh(), inventoryRefreshIntervalMs);
  }

  readonly onDidChangeTreeData = this.refreshEvent.event;

  refresh(): void {
    if (this.disposed) {
      return;
    }
    for (const connection of this.connectionStore.getConnections()) {
      this.resourceRequestVersions.set(connection.id, (this.resourceRequestVersions.get(connection.id) ?? 0) + 1);
    }
    this.resourceCache.clear();
    this.storageCache.clear();
    this.snapshotCache.clear();
    this.refreshEvent.fire();
  }

  refreshConnection(connectionId: string): void {
    if (this.disposed) {
      return;
    }
    this.invalidateConnection(connectionId);
    this.refreshEvent.fire();
  }

  // Clears cached inventory without firing onDidChangeTreeData, so callers already
  // rebuilding children (e.g. getChildren) don't trigger a recursive refresh loop.
  private invalidateConnection(connectionId: string): void {
    this.resourceCache.delete(connectionId);
    this.resourceRequestVersions.set(connectionId, (this.resourceRequestVersions.get(connectionId) ?? 0) + 1);
    for (const key of this.storageCache.keys()) {
      if (key.startsWith(`${treeItemId('storageCache', connectionId)}:`)) {
        this.storageCache.delete(key);
      }
    }
    for (const key of this.snapshotCache.keys()) {
      if (key.startsWith(`${treeItemId('snapshotCache', connectionId)}:`)) {
        this.snapshotCache.delete(key);
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.inventoryRefreshTimer);
    this.refreshEvent.dispose();
    this.resourceCache.clear();
    this.resourceRequests.clear();
    this.resourceRequestVersions.clear();
    this.storageCache.clear();
    this.storageRequests.clear();
    this.snapshotCache.clear();
    this.snapshotRequests.clear();
  }

  getTreeItem(element: ProxmoxItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProxmoxItem): Promise<ProxmoxItem[]> {
    if (this.disposed) {
      return [];
    }
    if (element === undefined) {
      const connections = this.connectionStore.getConnections();
      return connections.length === 0
        ? [new MessageItem('Add a Proxmox connection to get started.', true)]
        : connections.map((connection) => new ConnectionItem(connection));
    }

    if (element instanceof ConnectionItem) {
      return this.loadNodes(element.connection);
    }

    if (element instanceof NodeItem) {
      return this.loadNodeChildren(element);
    }

    if (element instanceof GuestItem) {
      return this.loadSnapshots(element);
    }

    return [];
  }

  private async loadNodeChildren(node: NodeItem): Promise<ProxmoxItem[]> {
    const guestItems = node.resources.map((resource) => new GuestItem(node.connection, resource, this.inFlightGuestActions));
    let credentials;
    try {
      credentials = await this.connectionStore.getCredentials(node.connection);
    } catch {
      return [...guestItems, new MessageItem('Unable to read the Proxmox token secret.')];
    }
    if (credentials === undefined) {
      return [...guestItems, new MessageItem('Credentials are missing.')];
    }

    const cacheKey = treeItemId('storageCache', node.connection.id, node.node);
    const cachedStorage = this.storageCache.get(cacheKey);
    if (cachedStorage !== undefined) {
      return nodeChildren(guestItems, cachedStorage, node);
    }

    const requestVersion = this.resourceRequestVersions.get(node.connection.id) ?? 0;
    let requestState = this.storageRequests.get(cacheKey);
    if (requestState === undefined || requestState.version !== requestVersion) {
      requestState = {
        version: requestVersion,
        request: this.loadStorageWithRetry(node.connection, credentials, node.node)
      };
      this.storageRequests.set(cacheKey, requestState);
    }

    try {
      const storage = [...await requestState.request]
        .sort((left, right) => compareLabels(left.storage, right.storage));
      if (this.disposed) {
        return [];
      }
      const latestVersion = this.resourceRequestVersions.get(node.connection.id) ?? 0;
      if (latestVersion !== requestVersion) {
        const latestCachedStorage = this.storageCache.get(cacheKey);
        if (latestCachedStorage !== undefined) {
          return nodeChildren(guestItems, latestCachedStorage, node);
        }
        const latestRequestState = this.storageRequests.get(cacheKey);
        if (latestRequestState !== undefined && latestRequestState !== requestState) {
          const latestStorage = [...await latestRequestState.request]
            .sort((left, right) => compareLabels(left.storage, right.storage));
          if ((this.resourceRequestVersions.get(node.connection.id) ?? 0) === latestRequestState.version) {
            this.storageCache.set(cacheKey, latestStorage);
          }
          return nodeChildren(guestItems, latestStorage, node);
        }
        return [...guestItems, new MessageItem('Refreshing storage...')];
      }

      this.storageCache.set(cacheKey, storage);
      return nodeChildren(guestItems, storage, node);
    } catch (error) {
      return storageErrorChildren(guestItems, error);
    } finally {
      if (this.storageRequests.get(cacheKey) === requestState) {
        this.storageRequests.delete(cacheKey);
      }
    }
  }

  private async loadStorageWithRetry(
    connection: ProxmoxConnection,
    credentials: { readonly tokenSecret: string },
    node: string
  ): Promise<readonly StorageResource[]> {
    const service = new ProxmoxService(connection, credentials);
    try {
      return await service.loadStorage(node);
    } catch (error) {
      if (!isTransientStorageError(error)) {
        throw error;
      }
      return service.loadStorage(node);
    }
  }

  private async loadNodes(connection: ProxmoxConnection): Promise<ProxmoxItem[]> {
    const cachedResources = this.resourceCache.get(connection.id);
    if (cachedResources !== undefined) {
      return connectionChildren(connection, cachedResources.guests, cachedResources.nodes);
    }

    let credentials;
    try {
      credentials = await this.connectionStore.getCredentials(connection);
    } catch {
      return [new MessageItem('Unable to read the Proxmox token secret.')];
    }
    if (credentials === undefined) {
      return [new MessageItem('Credentials are missing. Remove and add this connection again.')];
    }

    const requestVersion = this.resourceRequestVersions.get(connection.id) ?? 0;
    let requestState = this.resourceRequests.get(connection.id);
    if (requestState === undefined || requestState.version !== requestVersion) {
      const request = new ProxmoxService(connection, credentials).loadClusterResources().then((resources) => ({
        guests: uniqueById(resources.filter((resource) =>
          (resource.type === 'qemu' || resource.type === 'lxc')
          && typeof resource.node === 'string'
          && resource.node.trim() !== '')),
        nodes: resources
          .filter((resource) => resource.type === 'node' && resource.node !== undefined)
          .map((resource) => resource.node as string)
          .filter((node, index, nodes) => nodes.indexOf(node) === index)
      }));
      requestState = { version: requestVersion, request };
      this.resourceRequests.set(connection.id, requestState);
    }

    try {
      const resourceData = await requestState.request;
      if (this.disposed) {
        return [];
      }
      const latestVersion = this.resourceRequestVersions.get(connection.id) ?? 0;
      if (latestVersion !== requestVersion) {
        const latestCachedResources = this.resourceCache.get(connection.id);
        if (latestCachedResources !== undefined) {
          return connectionChildren(connection, latestCachedResources.guests, latestCachedResources.nodes);
        }
        const latestRequestState = this.resourceRequests.get(connection.id);
        if (latestRequestState !== undefined && latestRequestState !== requestState) {
          const latestResourceData = await latestRequestState.request;
          if ((this.resourceRequestVersions.get(connection.id) ?? 0) === latestRequestState.version) {
            this.resourceCache.set(connection.id, latestResourceData);
          }
          return connectionChildren(connection, latestResourceData.guests, latestResourceData.nodes);
        }
        return [new MessageItem('Refreshing Proxmox resources...')];
      }

      this.resourceCache.set(connection.id, resourceData);
      return connectionChildren(connection, resourceData.guests, resourceData.nodes);
    } catch (error) {
      return [new MessageItem(formatError(error))];
    } finally {
      if (this.resourceRequests.get(connection.id) === requestState) {
        this.resourceRequests.delete(connection.id);
      }
    }
  }

  private async loadSnapshots(guest: GuestItem): Promise<ProxmoxItem[]> {
    if (guest.resource.vmid === undefined || guest.resource.node === undefined) {
      return [new MessageItem('Snapshot data is unavailable for this guest.')];
    }

    let credentials;
    try {
      credentials = await this.connectionStore.getCredentials(guest.connection);
    } catch {
      return [new MessageItem('Unable to read the Proxmox token secret.')];
    }
    if (credentials === undefined) {
      return [new MessageItem('Credentials are missing.')];
    }

    const type = guest.resource.type === 'qemu' ? 'qemu' : 'lxc';
    const cacheKey = treeItemId(
      'snapshotCache',
      guest.connection.id,
      guest.resource.node,
      type,
      guest.resource.vmid
    );
    const cached = this.snapshotCache.get(cacheKey);
    if (cached !== undefined) {
      return snapshotItems(cached, guest);
    }

    const requestVersion = this.resourceRequestVersions.get(guest.connection.id) ?? 0;
    let requestState = this.snapshotRequests.get(cacheKey);
    if (requestState === undefined || requestState.version !== requestVersion) {
      const request = new ProxmoxService(guest.connection, credentials).loadSnapshots(
        type,
        guest.resource.node,
        guest.resource.vmid
      );
      requestState = { version: requestVersion, request };
      this.snapshotRequests.set(cacheKey, requestState);
    }

    try {
      const snapshots = await requestState.request;
      if (this.disposed) {
        return [];
      }
      const latestVersion = this.resourceRequestVersions.get(guest.connection.id) ?? 0;
      if (latestVersion !== requestVersion) {
        const latestCachedSnapshots = this.snapshotCache.get(cacheKey);
        if (latestCachedSnapshots !== undefined) {
          return snapshotItems(latestCachedSnapshots, guest);
        }
        const latestRequestState = this.snapshotRequests.get(cacheKey);
        if (latestRequestState !== undefined && latestRequestState !== requestState) {
          const latestSnapshots = await latestRequestState.request;
          if ((this.resourceRequestVersions.get(guest.connection.id) ?? 0) === latestRequestState.version) {
            this.snapshotCache.set(cacheKey, latestSnapshots);
          }
          return snapshotItems(latestSnapshots, guest);
        }
        return [new MessageItem('Refreshing snapshots...')];
      }

      this.snapshotCache.set(cacheKey, snapshots);
      return snapshotItems(snapshots, guest);
    } catch (error) {
      return [new MessageItem(`Snapshots unavailable: ${formatError(error)}`)];
    } finally {
      if (this.snapshotRequests.get(cacheKey) === requestState) {
        this.snapshotRequests.delete(cacheKey);
      }
    }
  }
}

function snapshotItems(snapshots: readonly SnapshotResource[], guest: GuestItem): ProxmoxItem[] {
  return snapshots.length === 0
    ? [new MessageItem('No snapshots found.')]
    : [...snapshots]
      .sort((left, right) => (right.snaptime ?? 0) - (left.snaptime ?? 0) || compareLabels(left.name, right.name))
      .map((snapshot) => new SnapshotItem(snapshot, snapshotItemId(guest, snapshot)));
}

function nodeChildren(
  guests: readonly GuestItem[],
  storage: readonly StorageResource[],
  node: NodeItem
): ProxmoxItem[] {
  const storageItems = storage.map((resource) => new StorageItem(node.connection.id, node.node, resource));
  return guests.length === 0 && storageItems.length === 0
    ? [new MessageItem('No guests or storage found.')]
    : [...guests, ...storageItems];
}

function storageErrorChildren(guests: readonly GuestItem[], error: unknown): ProxmoxItem[] {
  return guests.length > 0
    ? [...guests]
    : [new MessageItem(`No guests found. Storage could not be loaded: ${formatError(error)}`)];
}

function connectionChildren(
  connection: ProxmoxConnection,
  guests: readonly ClusterResource[],
  nodes: readonly string[]
): ProxmoxItem[] {
  const nodeItems = groupByNode(connection, guests, nodes);
  return nodeItems.length === 0 ? [new MessageItem('No Proxmox nodes found.')] : nodeItems;
}

function uniqueById(resources: readonly ClusterResource[]): ClusterResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    if (seen.has(resource.id)) {
      return false;
    }
    seen.add(resource.id);
    return true;
  });
}

function snapshotItemId(guest: GuestItem, snapshot: SnapshotResource): string {
  return treeItemId(
    'snapshot',
    guest.connection.id,
    guest.resource.node,
    guest.resource.type,
    guest.resource.vmid,
    snapshot.name
  );
}

function treeItemId(type: string, ...parts: readonly unknown[]): string {
  return [type, ...parts].map((value) => encodeURIComponent(String(value))).join(':');
}

function groupByNode(
  connection: ProxmoxConnection,
  resources: readonly ClusterResource[],
  nodeNames: readonly string[] = []
): NodeItem[] {
  const grouped = new Map<string, ClusterResource[]>();
  for (const node of nodeNames) {
    grouped.set(node, []);
  }

  for (const resource of resources) {
    if (resource.node === undefined || resource.node.trim() === '') {
      continue;
    }
    const node = resource.node;
    const nodeResources = grouped.get(node) ?? [];
    nodeResources.push(resource);
    grouped.set(node, nodeResources);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareLabels(left, right))
    .map(([node, nodeResources]) => new NodeItem(connection, node, sortGuests(nodeResources)));
}

function sortGuests(resources: readonly ClusterResource[]): ClusterResource[] {
  return [...resources].sort((left, right) =>
    compareLabels(left.name ?? '', right.name ?? '') || (left.vmid ?? 0) - (right.vmid ?? 0));
}

function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function nodeGuestSummary(resources: readonly ClusterResource[]): string {
  const count = resources.length;
  const running = resources.filter((resource) => resource.status === 'running').length;
  const guestLabel = `${count} guest${count === 1 ? '' : 's'}`;
  return running > 0 ? `${guestLabel} (${running} running)` : guestLabel;
}

function formatGuestTooltip(resource: ClusterResource): string {
  const details = [
    resource.name,
    resource.status === undefined ? undefined : `Status: ${resource.status}`,
    resource.cpu === undefined || resource.maxcpu === undefined ? undefined : `CPU: ${resource.cpu}/${resource.maxcpu}`,
    resource.mem === undefined || resource.maxmem === undefined
      ? undefined
      : `Memory: ${formatBytes(resource.mem)} / ${formatBytes(resource.maxmem)}`,
    resource.uptime === undefined ? undefined : `Uptime: ${resource.uptime}s`
  ];
  return details.filter(Boolean).join('\n');
}

function guestIcon(type: string, status?: string): vscode.ThemeIcon {
  const icon = type === 'qemu' ? 'vm' : 'package';
  const color = status === 'running'
    ? new vscode.ThemeColor('testing.iconPassed')
    : status === 'stopped'
      ? new vscode.ThemeColor('disabledForeground')
      : status === 'starting' || status === 'stopping'
        ? new vscode.ThemeColor('charts.yellow')
      : undefined;
  return new vscode.ThemeIcon(icon, color);
}

function guestCpuSummary(resource: ClusterResource): string {
  if (resource.cpu === undefined || resource.maxcpu === undefined || resource.maxcpu <= 0) {
    return 'CPU unavailable';
  }

  return `CPU ${(resource.cpu * 100).toFixed(1)}% / ${resource.maxcpu} count`;
}

function formatStorageTooltip(storage: StorageResource): string {
  const details = [
    storage.storage,
    `Type: ${storage.type}`,
    storage.content === undefined ? undefined : `Content: ${storage.content}`,
    storage.total === undefined ? undefined : `Total: ${formatBytes(storage.total)}`,
    storage.used === undefined ? undefined : `Used: ${formatBytes(storage.used)}`,
    storage.avail === undefined ? undefined : `Available: ${formatBytes(storage.avail)}`
  ];
  return details.filter(Boolean).join('\n');
}

function formatSnapshotDescription(snapshot: SnapshotResource): string | undefined {
  const details = [
    snapshot.snaptime === undefined ? undefined : new Date(snapshot.snaptime * 1000).toLocaleString(),
    snapshot.vmstate === 1 ? 'includes memory' : undefined
  ];
  return details.filter(Boolean).join(' | ') || undefined;
}

function formatSnapshotTooltip(snapshot: SnapshotResource): string {
  const details = [
    snapshot.name,
    snapshot.description,
    snapshot.parent === undefined ? undefined : `Parent: ${snapshot.parent}`,
    snapshot.snaptime === undefined ? undefined : `Created: ${new Date(snapshot.snaptime * 1000).toLocaleString()}`,
    snapshot.vmstate === undefined ? undefined : `Memory state: ${snapshot.vmstate === 1 ? 'included' : 'not included'}`
  ];
  return details.filter(Boolean).join('\n');
}

function storageSummary(storage: StorageResource): string {
  if (storage.used === undefined || storage.total === undefined || storage.total === 0) {
    return storage.type;
  }

  return `${storage.type} | ${formatBytes(storage.used)} / ${formatBytes(storage.total)}`;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KiB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${Math.round(value / (1024 * 1024))} MiB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load Proxmox resources.';
}

function isTransientStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('timed out')
    || message.includes('timeout')
    || message.includes('unable to connect')
    || message.includes('socket hang up')
    || message.includes('ecconnreset')
    || message.includes('econnreset')
    || message.includes('aborted')
    || message.includes('temporarily unavailable');
}
