import { ProxmoxClient } from './proxmoxClient';
import { ClusterResource, GuestDetailInfo, PollingConfig, PollingProgressCallback, ProxmoxConnection, ProxmoxCredentials, SnapshotResource, StorageResource } from './proxmoxTypes';

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

  async loadGuestConfig(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<GuestDetailInfo> {
    const client = this.createClient();
    const config = await client.getGuestConfig(type, node, vmid, signal);
    const resources = await client.getClusterResources(signal);

    // Find the resource entry to get status and uptime
    const resource = resources.find((r) => r.type === type && r.vmid === vmid && r.node === node);

    return {
      vmid,
      node,
      type,
      name: config.name as string | undefined,
      status: resource?.status as string | undefined,
      cores: config.cores as number | undefined,
      cpulimit: config.cpulimit as number | undefined,
      cpuunits: config.cpuunits as number | undefined,
      memory: config.memory as number | undefined,
      balloon: config.balloon as number | undefined,
      rootfs: config.rootfs as string | undefined,
      sata: config.sata as Record<string, unknown> | undefined,
      virtio: config.virtio as Record<string, unknown> | undefined,
      ide: config.ide as Record<string, unknown> | undefined,
      scsi: config.scsi as Record<string, unknown> | undefined,
      boot: config.boot as string | undefined,
      bootdisk: config.bootdisk as string | undefined,
      net: config.net as Record<string, unknown> | undefined,
      ostype: config.ostype as string | undefined,
      osrelease: config.osrelease as string | undefined,
      hostname: config.hostname as string | undefined,
      tags: config.tags as string | undefined,
      onboot: config.onboot as number | undefined,
      autostart: config.autostart as number | undefined,
      protection: config.protection as number | undefined,
      lock: config.lock as string | undefined,
      description: config.description as string | undefined,
      uptime: resource?.uptime
    };
  }

  startGuest(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<void> {
    return this.createClient().startGuest(type, node, vmid, signal)
      .then((upid) => this.createClient().waitForTask(node, upid, signal));
  }

  stopGuest(type: 'lxc' | 'qemu', node: string, vmid: number, signal?: AbortSignal): Promise<void> {
    return this.createClient().stopGuest(type, node, vmid, signal)
      .then((upid) => this.createClient().waitForTask(node, upid, signal));
  }

  /**
   * Start a guest with optional progress callback and configurable polling.
   * Uses container-specific polling interval (3s) for faster feedback.
   *
   * @param type - Guest type: 'lxc' or 'qemu'
   * @param node - Node name hosting the guest
   * @param vmid - Virtual machine ID
   * @param onProgress - Optional callback for polling progress updates
   * @param config - Optional polling configuration (defaults to container interval)
   * @param signal - Optional AbortSignal for cancellation
   */
  async startGuestWithProgress(
    type: 'lxc' | 'qemu',
    node: string,
    vmid: number,
    onProgress?: PollingProgressCallback,
    config?: PollingConfig,
    signal?: AbortSignal
  ): Promise<void> {
    const pollingConfig = { ...config, containerIntervalMs: config?.containerIntervalMs ?? 3000 };
    const upid = await this.createClient().startGuest(type, node, vmid, signal);
    return this.createClient().pollTaskWithProgress(node, upid, onProgress, pollingConfig, signal);
  }

  /**
   * Stop a guest with optional progress callback and configurable polling.
   * Uses container-specific polling interval (3s) for faster feedback.
   *
   * @param type - Guest type: 'lxc' or 'qemu'
   * @param node - Node name hosting the guest
   * @param vmid - Virtual machine ID
   * @param onProgress - Optional callback for polling progress updates
   * @param config - Optional polling configuration (defaults to container interval)
   * @param signal - Optional AbortSignal for cancellation
   */
  async stopGuestWithProgress(
    type: 'lxc' | 'qemu',
    node: string,
    vmid: number,
    onProgress?: PollingProgressCallback,
    config?: PollingConfig,
    signal?: AbortSignal
  ): Promise<void> {
    const pollingConfig = { ...config, containerIntervalMs: config?.containerIntervalMs ?? 3000 };
    const upid = await this.createClient().stopGuest(type, node, vmid, signal);
    return this.createClient().pollTaskWithProgress(node, upid, onProgress, pollingConfig, signal);
  }

  private createClient(): ProxmoxClient {
    return new ProxmoxClient(this.connection, this.credentials);
  }
}
