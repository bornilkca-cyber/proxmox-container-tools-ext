import * as vscode from 'vscode';
import { isProxmoxConnection, ProxmoxConnection, ProxmoxCredentials } from './proxmoxTypes';

const connectionsKey = 'proxmox.connections';
const secretPrefix = 'proxmox.token.';

export class ConnectionStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  getConnections(): readonly ProxmoxConnection[] {
    const stored = this.context.globalState.get<unknown>(connectionsKey, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    const unique = new Map<string, ProxmoxConnection>();
    for (const connection of stored) {
      if (isProxmoxConnection(connection)) {
        const normalized = sanitizeConnection(connection);
        unique.set(normalized.id, normalized);
      }
    }
    return [...unique.values()];
  }

  async save(connection: ProxmoxConnection, credentials: ProxmoxCredentials): Promise<void> {
    const normalizedConnection = sanitizeConnection(connection);
    if (!isProxmoxConnection(normalizedConnection)) {
      throw new Error('Invalid Proxmox connection.');
    }

    const normalizedCredentials = sanitizeCredentials(credentials);
    if (normalizedCredentials.tokenSecret.trim() === '') {
      throw new Error('Proxmox API token secret is missing.');
    }

    return this.enqueueMutation(async () => {
      const connections = this.getConnections().filter((item) => item.id !== normalizedConnection.id);
      const secretKey = this.secretKey(normalizedConnection.id);
      const previousTokenSecret = await this.context.secrets.get(secretKey);
      await this.context.secrets.store(secretKey, normalizedCredentials.tokenSecret);
      try {
        await this.context.globalState.update(connectionsKey, [...connections, normalizedConnection]);
      } catch (error) {
        try {
          if (previousTokenSecret === undefined) {
            await this.context.secrets.delete(secretKey);
          } else {
            await this.context.secrets.store(secretKey, previousTokenSecret);
          }
          // eslint-disable-next-line no-empty
        } catch {
        }
        throw error;
      }
    });
  }

  async getCredentials(connection: ProxmoxConnection): Promise<ProxmoxCredentials | undefined> {
    const tokenSecret = await this.context.secrets.get(this.secretKey(connection.id));
    return tokenSecret === undefined ? undefined : sanitizeCredentials({ tokenSecret });
  }

  async update(connection: ProxmoxConnection): Promise<void> {
    return this.enqueueMutation(async () => {
      const normalizedConnection = sanitizeConnection(connection);
      if (!isProxmoxConnection(normalizedConnection)) {
        throw new Error('Invalid Proxmox connection.');
      }

      const connections = this.getConnections().filter((item) => item.id !== normalizedConnection.id);
      await this.context.globalState.update(connectionsKey, [...connections, normalizedConnection]);
    });
  }

  async remove(connection: ProxmoxConnection): Promise<void> {
    return this.enqueueMutation(async () => {
      const connections = this.getConnections();
      const remainingConnections = connections.filter((item) => item.id !== connection.id);
      await this.context.globalState.update(connectionsKey, remainingConnections);
      try {
        await this.context.secrets.delete(this.secretKey(connection.id));
      } catch (error) {
        try {
          await this.context.globalState.update(connectionsKey, connections);
          // eslint-disable-next-line no-empty
        } catch {
        }
        throw error;
      }
    });
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(operation);
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }

  private secretKey(connectionId: string): string {
    return `${secretPrefix}${connectionId}`;
  }
}

function sanitizeConnection(connection: ProxmoxConnection): ProxmoxConnection {
  const certificateFingerprint = normalizeCertificateFingerprint(connection.certificateFingerprint);
  const sanitized: ProxmoxConnection = {
    ...connection,
    id: connection.id.trim(),
    name: connection.name.trim(),
    baseUrl: connection.baseUrl.trim(),
    realm: connection.realm.trim(),
    username: connection.username.trim(),
    tokenId: connection.tokenId.trim()
  };
  return certificateFingerprint === undefined
    ? sanitized
    : { ...sanitized, certificateFingerprint };
}

function sanitizeCredentials(credentials: ProxmoxCredentials): ProxmoxCredentials {
  return {
    tokenSecret: typeof credentials.tokenSecret === 'string' ? credentials.tokenSecret.trim() : ''
  };
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
