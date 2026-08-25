import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { readCertificateFingerprint } from './certificateTrust';
import { ConnectionStore } from './connectionStore';
import { DashboardPanelProvider } from './dashboardPanel';
import { GuestDetailsPanelProvider } from './guestDetailsPanel';
import { ProxmoxExplorerProvider } from './explorerProvider';
import { ProxmoxService } from './proxmoxService';
import { ProxmoxConnection, ClusterResource } from './proxmoxTypes';
import { buildLxcShellUrl, buildSshCommand, guestActionKey, resolveGuestActionItem, resolveShellItem } from './shellAccess';

export function activate(context: vscode.ExtensionContext): void {
  const connectionStore = new ConnectionStore(context);
  const inFlightGuestActions = new Set<string>();
  const explorerProvider = new ProxmoxExplorerProvider(connectionStore, inFlightGuestActions);
  const guestDetailsPanel = new GuestDetailsPanelProvider(context.extensionUri);
  const dashboardPanel = new DashboardPanelProvider(context.extensionUri);

  const proxmoxTree = vscode.window.createTreeView('proxmoxExplorer', {
    treeDataProvider: explorerProvider,
    showCollapseAll: true
  });

  // Handle tree selection changes to update guest details panel and dashboard
  const updateGuestDetails = () => {
    const selectedItem = proxmoxTree.selection[0];

    // Only update panel if a guest is selected
    if (selectedItem && typeof selectedItem === 'object' && 'connection' in selectedItem && 'resource' in selectedItem) {
      const guest = selectedItem as { connection: ProxmoxConnection; resource: ClusterResource };
      if (guest.resource.vmid !== undefined && guest.resource.node !== undefined) {
        // Load credentials and fetch guest config
        (async () => {
          try {
            const credentials = await connectionStore.getCredentials(guest.connection);
            if (credentials === undefined) {
              guestDetailsPanel.updateGuest(undefined);
              dashboardPanel.updateGuest(undefined);
              return;
            }

            const service = new ProxmoxService(guest.connection, credentials);
            // eslint-disable @typescript-eslint/no-non-null-assertion
            const guestInfo = await service.loadGuestConfig(
              guest.resource.type as 'lxc' | 'qemu',
              guest.resource.node!,
              guest.resource.vmid!
            );
            // eslint-enable @typescript-eslint/no-non-null-assertion
            guestDetailsPanel.updateGuest(guestInfo);
            // Update dashboard with guest config and resource data
            dashboardPanel.updateGuest({ ...guestInfo, resource: guest.resource });
          } catch {
            guestDetailsPanel.updateGuest(undefined);
            dashboardPanel.updateGuest(undefined);
          }
        })();
      } else {
        guestDetailsPanel.updateGuest(undefined);
        dashboardPanel.updateGuest(undefined);
      }
    } else {
      guestDetailsPanel.updateGuest(undefined);
      dashboardPanel.updateGuest(undefined);
    }
  };

  proxmoxTree.onDidChangeSelection(updateGuestDetails);

  context.subscriptions.push(
    proxmoxTree,
    explorerProvider,
    guestDetailsPanel,
    dashboardPanel,
    vscode.window.registerWebviewViewProvider(GuestDetailsPanelProvider.viewType, guestDetailsPanel),
    vscode.window.registerWebviewViewProvider(DashboardPanelProvider.viewType, dashboardPanel),
    vscode.commands.registerCommand('proxmox.refresh', () => explorerProvider.refresh()),
    vscode.commands.registerCommand('proxmox.refreshConnection', (item: unknown) => {
      const connection = resolveConnectionItem(item, proxmoxTree.selection, connectionStore);
      if (connection === undefined) {
        vscode.window.showErrorMessage('Select a Proxmox connection first.');
        return;
      }
      explorerProvider.refreshConnection(connection.id);
    }),
    vscode.commands.registerCommand('proxmox.openShell', async (item: unknown) => {
      const shellItem = resolveShellItem(item, proxmoxTree.selection);
      if (shellItem === undefined) {
        vscode.window.showErrorMessage('Shell access is available only for LXC containers.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(buildLxcShellUrl(shellItem)));
    }),
    vscode.commands.registerCommand('proxmox.openServerBrowser', async (item: unknown) => {
      const connection = resolveConnectionItem(item, proxmoxTree.selection, connectionStore);
      if (connection === undefined) {
        vscode.window.showErrorMessage('Select a Proxmox server first.');
        return;
      }
      const urlError = validateHttpsUrl(connection.baseUrl);
      if (urlError !== undefined) {
        vscode.window.showErrorMessage(`Cannot open server in browser: ${urlError}`);
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(connection.baseUrl));
    }),
    vscode.commands.registerCommand('proxmox.openSshTerminal', async (item: unknown) => {
      const guest = resolveGuestActionItem(item, proxmoxTree.selection);
      if (guest === undefined) {
        vscode.window.showErrorMessage('Select a QEMU virtual machine or LXC container first.');
        return;
      }

      const username = resolveLocalUsername();
      if (username === undefined || username === '') {
        vscode.window.showErrorMessage('The local SSH username is unavailable.');
        return;
      }

      // Try to fetch guest config to get the hostname, fall back to server hostname
      let hostname = new URL(guest.connection.baseUrl).hostname;

      try {
        const credentials = await connectionStore.getCredentials(guest.connection);
        if (credentials !== undefined) {
          const service = new ProxmoxService(guest.connection, credentials);
          const config = await service.loadGuestConfig(
            guest.resource.type as 'lxc' | 'qemu',
            guest.resource.node,
            guest.resource.vmid
          );
          // Use guest hostname if available and valid, otherwise use server hostname
          if (config.hostname && typeof config.hostname === 'string' && config.hostname.trim() !== '') {
            hostname = config.hostname;
          }
        }
      } catch {
        // Silently ignore errors and fall back to server hostname
        // This ensures SSH terminal opens even if config fetch fails
      }

      const terminal = vscode.window.createTerminal({
        name: `SSH ${guest.resource.name ?? guest.resource.vmid}`
      });
      terminal.show();
      terminal.sendText(buildSshCommand(username, hostname), true);
    }),
    vscode.commands.registerCommand('proxmox.startGuest', (item: unknown) =>
      runGuestAction('start', item, proxmoxTree.selection, connectionStore, explorerProvider, inFlightGuestActions)),
    vscode.commands.registerCommand('proxmox.stopGuest', (item: unknown) =>
      runGuestAction('stop', item, proxmoxTree.selection, connectionStore, explorerProvider, inFlightGuestActions)),
    vscode.commands.registerCommand('proxmox.trustCertificate', async (item: unknown) => {
      const connection = resolveConnectionItem(item, proxmoxTree.selection, connectionStore);
      if (connection === undefined) {
        vscode.window.showErrorMessage('Select a Proxmox connection first.');
        return;
      }

      try {
        const fingerprint = await readCertificateFingerprint(connection.baseUrl);
        const confirmation = await vscode.window.showWarningMessage(
          `Trust this server certificate for "${connection.name}"?\nSHA-256: ${fingerprint}`,
          { modal: true },
          'Trust Certificate'
        );
        if (confirmation === 'Trust Certificate') {
          await connectionStore.update({
            ...connection,
            certificateFingerprint: fingerprint
          });
          explorerProvider.refreshConnection(connection.id);
          vscode.window.showInformationMessage(`Certificate trusted for "${connection.name}".`);
        }
      } catch {
        vscode.window.showErrorMessage('Unable to read the Proxmox server certificate.');
      }
    }),
    vscode.commands.registerCommand('proxmox.addConnection', async () => {
      const name = await requiredInput('Connection name');
      if (name === undefined) {
        return;
      }

      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Proxmox VE server URL',
        placeHolder: 'https://host:8006',
        ignoreFocusOut: true,
        validateInput: (value) => validateHttpsUrl(value)
      });
      if (baseUrl === undefined) {
        return;
      }

      const realm = await requiredInput('Proxmox realm', 'pve');
      if (realm === undefined) {
        return;
      }

      const username = await requiredInput('Username');
      if (username === undefined) {
        return;
      }

      const tokenId = await requiredInput('API token ID');
      if (tokenId === undefined) {
        return;
      }

      const tokenSecret = await requiredInput('API token secret', undefined, true);
      if (tokenSecret === undefined) {
        return;
      }

      const connection = {
        id: randomUUID(),
        name,
        baseUrl: normalizeBaseUrl(baseUrl),
        realm,
        username,
        tokenId
      };
      try {
        await connectionStore.save(connection, { tokenSecret: tokenSecret.trim() });
        explorerProvider.refresh();
        vscode.window.showInformationMessage(`Connection "${name}" added.`);
      } catch {
        vscode.window.showErrorMessage('Unable to save the Proxmox connection.');
      }
    }),
    vscode.commands.registerCommand('proxmox.updateConnection', async (item: unknown) => {
      const existing = resolveConnectionItem(item, proxmoxTree.selection, connectionStore);
      if (existing === undefined) {
        vscode.window.showErrorMessage('Select a Proxmox connection first.');
        return;
      }

      const name = await requiredInput('Connection name', existing.name);
      if (name === undefined) {
        return;
      }

      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Proxmox VE server URL',
        value: existing.baseUrl,
        ignoreFocusOut: true,
        validateInput: (value) => validateHttpsUrl(value)
      });
      if (baseUrl === undefined) {
        return;
      }

      const realm = await requiredInput('Proxmox realm', existing.realm);
      if (realm === undefined) {
        return;
      }
      const username = await requiredInput('Username', existing.username);
      if (username === undefined) {
        return;
      }
      const tokenId = await requiredInput('API token ID', existing.tokenId);
      if (tokenId === undefined) {
        return;
      }

      const replacementSecret = await vscode.window.showInputBox({
        prompt: 'New API token secret (leave blank to keep current secret)',
        password: true,
        ignoreFocusOut: true
      });
      if (replacementSecret === undefined) {
        return;
      }

      let currentCredentials: { readonly tokenSecret: string } | undefined;
      try {
        currentCredentials = await connectionStore.getCredentials(existing);
      } catch {
        vscode.window.showErrorMessage('Unable to read the existing Proxmox token secret.');
        return;
      }
      if (currentCredentials === undefined && replacementSecret.trim() === '') {
        vscode.window.showErrorMessage('The existing token secret is missing. Enter a replacement secret.');
        return;
      }

      const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      const updatedConnection = {
        ...existing,
        name,
        baseUrl: normalizedBaseUrl,
        realm,
        username,
        tokenId,
        certificateFingerprint: normalizedBaseUrl === existing.baseUrl
          ? existing.certificateFingerprint
          : undefined
      };
      // eslint-disable @typescript-eslint/no-non-null-assertion
      const credentials = {
        tokenSecret: replacementSecret.trim() === ''
          ? currentCredentials!.tokenSecret
          : replacementSecret.trim()
      };
      // eslint-enable @typescript-eslint/no-non-null-assertion

      try {
        await connectionStore.save(updatedConnection, credentials);
        explorerProvider.refresh();
        vscode.window.showInformationMessage(`Connection "${name}" updated.`);
        if (normalizedBaseUrl !== existing.baseUrl && existing.certificateFingerprint !== undefined) {
          vscode.window.showInformationMessage('The server URL changed. Trust the new server certificate before refreshing.');
        }
      } catch {
        vscode.window.showErrorMessage('Unable to update the Proxmox connection.');
      }
    }),
    vscode.commands.registerCommand('proxmox.removeConnection', async (item: unknown) => {
      const connection = resolveConnectionItem(item, proxmoxTree.selection, connectionStore);
      if (connection === undefined) {
        vscode.window.showErrorMessage('Select a Proxmox connection first.');
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Remove connection "${connection.name}"?`,
        { modal: true },
        'Remove'
      );
      if (confirmation === 'Remove') {
        try {
          await connectionStore.remove(connection);
          explorerProvider.refresh();
        } catch {
          vscode.window.showErrorMessage('Unable to remove the Proxmox connection.');
        }
      }
    })
  );
}

function resolveConnectionItem(
  item: unknown,
  selection: readonly vscode.TreeItem[],
  connectionStore: ConnectionStore
): ProxmoxConnection | undefined {
  const candidates = [item, selection[0]];
  const itemWithId = candidates.find((candidate): candidate is { id: string } =>
    typeof candidate === 'object' && candidate !== null && 'id' in candidate && typeof candidate.id === 'string');
  return itemWithId === undefined
    ? undefined
    : connectionStore.getConnections().find((connection) => connection.id === itemWithId.id);
}

async function runGuestAction(
  action: 'start' | 'stop',
  item: unknown,
  selection: readonly unknown[],
  connectionStore: ConnectionStore,
  explorerProvider: ProxmoxExplorerProvider,
  inFlightGuestActions: Set<string>
): Promise<void> {
  const guest = resolveGuestActionItem(item, selection);
  if (guest === undefined) {
    vscode.window.showErrorMessage('Select a QEMU virtual machine or LXC container first.');
    return;
  }

  const operationKey = guestActionKey(guest.connection.id, guest.resource.type, guest.resource.vmid);
  if (inFlightGuestActions.has(operationKey)) {
    vscode.window.showInformationMessage(`An operation is already in progress for ${guest.resource.type.toUpperCase()} ${guest.resource.vmid}.`);
    return;
  }

  try {
    const confirmationLabel = action === 'start' ? 'Start Guest' : 'Stop Guest';
    const confirmation = await vscode.window.showWarningMessage(
      `${action === 'start' ? 'Start' : 'Stop'} ${guest.resource.type.toUpperCase()} ${guest.resource.vmid} on ${guest.resource.node}?`,
      { modal: true },
      confirmationLabel
    );
    if (confirmation !== confirmationLabel) {
      return;
    }

    inFlightGuestActions.add(operationKey);
    explorerProvider.refreshConnection(guest.connection.id);

    let credentials: { readonly tokenSecret: string } | undefined;
    try {
      credentials = await connectionStore.getCredentials(guest.connection);
    } catch {
      vscode.window.showErrorMessage('Unable to read the Proxmox token secret.');
      return;
    }
    if (credentials === undefined) {
      vscode.window.showErrorMessage('Credentials are missing. Update this connection before retrying.');
      return;
    }

    try {
      const service = new ProxmoxService(guest.connection, credentials);

      // Create progress callback for UI updates
      const onProgress: (phase: 'polling' | 'stopped' | 'failed') => void = (phase) => {
        explorerProvider.onPollingProgress(
          guest.connection.id,
          guest.resource.type,
          guest.resource.vmid,
          phase
        );
      };

      if (action === 'start') {
        await service.startGuestWithProgress(
          guest.resource.type,
          guest.resource.node,
          guest.resource.vmid,
          onProgress
        );
      } else {
        await service.stopGuestWithProgress(
          guest.resource.type,
          guest.resource.node,
          guest.resource.vmid,
          onProgress
        );
      }
      vscode.window.showInformationMessage(`${guest.resource.type.toUpperCase()} ${guest.resource.vmid} ${action === 'start' ? 'started' : 'stopped'}.`);
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : `Unable to ${action} guest.`);
    }
  } finally {
    inFlightGuestActions.delete(operationKey);
    explorerProvider.refreshConnection(guest.connection.id);
  }
}

export function deactivate(): void {}

function validateHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') {
      return 'Use an HTTPS URL.';
    }
    if (url.pathname !== '/' && url.pathname.replace(/\/+$/, '') !== '/api2/json') {
      return 'Use the server root URL or /api2/json path.';
    }
    return url.username || url.password || url.search || url.hash
      ? 'Remove credentials, query parameters, and fragments from the URL.'
      : undefined;
  } catch {
    return 'Enter a valid HTTPS URL.';
  }
}

async function requiredInput(prompt: string, value?: string, password = false): Promise<string | undefined> {
  const result = await vscode.window.showInputBox({
    prompt,
    value,
    password,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim() === '' ? 'This value is required.' : undefined
  });
  return result?.trim();
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function resolveLocalUsername(): string | undefined {
  const fromEnv = process.env.USER?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const systemUsername = userInfo().username.trim();
    return systemUsername === '' ? undefined : systemUsername;
  } catch {
    return undefined;
  }
}
