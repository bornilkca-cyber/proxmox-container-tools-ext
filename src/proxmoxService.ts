import { ProxmoxClient } from './proxmoxClient';
import { ClusterResource, ProxmoxConnection, ProxmoxCredentials, SnapshotResource, StorageResource } from './proxmoxTypes';

export class ProxmoxService {
  constructor(
    private readonly connection: ProxmoxConnection,
    private readonly credentials: ProxmoxCredentials
  ) {}

  loadClusterResources(signal?: AbortSignal): Promise<ClusterResource[]> {
    return this.createClient().getClusterResources(signal);
  }

  loadStorage(node: string, signal?: AbortSignal): Promise<StorageResource[]> {
    return this.createClient().getStorage(node, signal);
  }

  loadSnapshots(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<SnapshotResource[]> {
    return this.createClient().getSnapshots(type, node, vmid, signal);
  }

  startGuest(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<void> {
    return this.createClient().startGuest(type, node, vmid, signal)
      .then((upid) => this.createClient().waitForTask(node, upid, signal));
  }

  stopGuest(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<void> {
    return this.createClient().stopGuest(type, node, vmid, signal)
      .then((upid) => this.createClient().waitForTask(node, upid, signal));
  }

  private createClient(): ProxmoxClient {
    return new ProxmoxClient(this.connection, this.credentials);
  }
}
