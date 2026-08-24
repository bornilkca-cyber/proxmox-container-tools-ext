# Installation Guide

## Current status

This project is an early MVP. The current build provides:

- A Proxmox view in the VS Code Explorer.
- Secure connection creation and removal.
- Connection metadata updates and optional API token rotation.
- API token storage through VS Code `SecretStorage`.
- Read-only node and QEMU/LXC guest inventory.
- Read-only storage inventory beneath each node.
- Read-only snapshot inventory beneath each QEMU/LXC guest.
- Guest status, VMID, CPU percentage/count, memory, and uptime details.
- Automatic inventory refresh every 60 seconds and on connection expansion.
- Confirmation-gated start and stop actions for QEMU virtual machines and LXC containers.

Guest shutdown, restart, VM console, snapshot creation/deletion, backup, and deletion commands are not implemented.

LXC containers provide an **Open Container Shell** action that opens the matching Proxmox xterm.js shell URL in the external browser. API tokens cannot access Proxmox console endpoints, so sign in there with a Proxmox user account that has `VM.Console` permission.

QEMU and LXC guests provide an **Open SSH Terminal** action. It opens a VS Code terminal and pastes `ssh $USER@hostname` using the extension host's `$USER` and the hostname from the connection URL. The command is not executed automatically; press Enter after reviewing or editing it. This requires SSH access to the Proxmox host and does not connect to the guest's container IP.

## Prerequisites

- VS Code 1.85 or newer.
- Node.js 18 or newer for compilation; Node.js 20 or newer is required for VSIX packaging.
- npm.
- Network access to the Proxmox VE server when using the extension.
- A Proxmox API token with read-only permissions for inventory and status queries.

The extension requires HTTPS URLs. Certificate validation should remain enabled. A self-signed certificate must be trusted by the environment running VS Code; do not disable TLS verification globally. The certificate must be trusted in the environment where the extension is installed, which may be different from the local desktop when using Remote SSH.

When you use **Proxmox: Trust Server Certificate**, the extension records the server's SHA-256 leaf-certificate fingerprint and pins future API requests to it. Fingerprints are normalized before storage, so case and standard compact versus colon-delimited formatting do not cause a mismatch.

## Install the packaged extension

If a VSIX package is available:

1. Open VS Code.
2. Open the Extensions view.
3. Select the `...` menu.
4. Choose **Install from VSIX...**.
5. Select `proxmox-container-tools-ext-0.0.1.vsix`.
6. Reload VS Code if prompted.

The same installation can be performed from a VS Code-capable terminal:

```bash
code --install-extension proxmox-container-tools-ext-0.0.1.vsix --force
```

For Remote SSH or another remote VS Code session, run the command in the environment where the extension should be installed. The CLI should report the target host before installation.

## Build from source

From the repository root:

```bash
npm install
npm run compile
```

The compiled JavaScript is written to `out/`.

To package a VSIX with the locally installed packager:

```bash
npm run package
```

This creates a versioned `.vsix` file in the repository root. Install it using the steps above.

VSIX packaging requires Node.js 20 or newer because the current `vsce` release requires it. The extension itself can still be compiled with Node.js 18. If the system `node` command is older than 20, run the packager with another Node 20+ runtime:

```bash
node node_modules/@vscode/vsce/vsce package --skip-license
```

## Install for development

1. Open the repository folder in VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` or use **Run and Debug** to launch an Extension Development Host.
5. Open the Command Palette and run **Proxmox: Add Connection**.
6. Open the Explorer and expand the **Proxmox** view.

The repository includes an Extension Development Host launch profile named **Run Proxmox Container Tools**. The profile compiles the extension before launching.

## Add a connection

Run **Proxmox: Add Connection** and provide:

- A display name.
- The Proxmox VE HTTPS URL, such as `https://host:8006`. The extension adds the Proxmox API path automatically.
- The Proxmox realm, normally `pve`.
- The username.
- The API token ID.
- The API token secret.

The server URL, realm, username, and token ID are stored as connection metadata. The token secret is stored separately in VS Code `SecretStorage`. Never put the token secret in `settings.json`, source control, shell history, screenshots, or issue reports.

To remove a connection, open its context menu in the Proxmox Explorer and choose **Proxmox: Remove Connection**. Removal requires confirmation and deletes the associated secret.

To update a connection, open its context menu and choose **Proxmox: Update Connection**. You can change the display name, server URL, realm, username, and token ID. Leave the replacement token secret blank to keep the current secret, or enter a new secret to rotate it. The connection is refreshed after a successful update.

Changing a server URL clears any certificate fingerprint trusted for the previous server. Trust the certificate for the new URL before refreshing its inventory.

## Proxmox permissions

The Explorer reads cluster inventory through `/api2/json/cluster/resources` and read-only snapshot metadata through `/api2/json/nodes/<node>/<type>/<VMID>/snapshot`. Assign the API token a read-only role that includes cluster auditing and guest metadata access, then assign guest-specific permissions as needed.

Run these commands on the Proxmox host as `root`, replacing `<VMID>` with the LXC or QEMU guest ID:

```bash
# Read-only cluster inventory for the Explorer
pveum acl modify / -token 'vscode@pve!PVE_VSCODE_TOKEN' -role PVEAuditor

# Read-only access to one guest
pveum acl modify "/vms/<VMID>" -token 'vscode@pve!PVE_VSCODE_TOKEN' -role PVEVMUser
```

Verify the token's effective permissions:

```bash
pveum user permissions 'vscode@pve!PVE_VSCODE_TOKEN'
```

When API-token privilege separation is enabled, grant the ACLs directly to the token identity as shown above. Otherwise, the token may not inherit the user account's permissions. Refresh the connection after changing ACLs.

The Proxmox view toolbar provides **Add Connection** and **Refresh All Connections** actions. The view context menu provides the same fallback actions when the toolbar is hidden. Connection rows provide inline refresh, update, and remove actions when available; the same actions are also available from the row context menu. Inventory refreshes every 60 seconds and when a connection is expanded. Per-connection refresh clears only that connection's cached inventory and snapshots.

Expand a QEMU or LXC guest to view its read-only snapshots. Snapshot entries show their name, creation time, parent, and whether memory state was included. Snapshot creation and deletion are not available yet.

Connections with an untrusted certificate show a warning-style server icon and an inline shield action. After trusting a certificate, the connection shows a verified icon; use its context menu to trust a replacement certificate after a server certificate rotation.

### Certificate mismatch

The error `The Proxmox server certificate does not match the certificate trusted for this connection.` means the current server certificate differs from the certificate previously pinned for that connection. This can occur after a Proxmox certificate rotation, a rebuilt node, a load balancer routing to a server with a different certificate, or a network interception attempt.

1. Obtain the current SHA-256 leaf-certificate fingerprint from a trusted administrative channel.
2. Compare it with the fingerprint shown by **Proxmox: Trust Server Certificate**.
3. Only when the values match, confirm the trust prompt to replace the old pin.
4. Refresh the connection.

Do not bypass certificate validation, remove the fingerprint from extension storage manually, or accept an unexpected replacement fingerprint. If the server uses multiple nodes or a load balancer, ensure every endpoint reached through the configured URL presents the same certificate.

## Read-only testing policy

The designated test server is strictly read-only. Live testing may use authentication and inventory/status/snapshot-list `GET` requests only.

Do not execute or add requests for:

- Start, stop, shutdown, reboot, or restart.
- Configuration changes.
- Task creation or task polling for an operation initiated by the extension.
- Snapshot or backup creation/deletion.
- Storage mutations.
- Deletion.

Use mocked responses for any future mutating-operation tests. Do not place the internal test server address or credentials in this repository.

## Troubleshooting

### The Proxmox view is missing

Reload VS Code and confirm that the extension is installed and enabled. Run **Developer: Show Running Extensions** to check activation status.

### The connection has no children

Expand the connection to trigger the read-only inventory request. Any server error is shown inline beneath the connection.

### Authentication fails

Check the server URL, realm, username, token ID, token permissions, and token secret. Recreate the connection after rotating or revoking a token.

### The certificate is rejected

Install or trust the issuing CA in the VS Code host environment, then reload VS Code and retry. For Remote SSH, install the CA on the remote host running the extension. Alternatively, open the connection context menu and choose **Proxmox: Trust Server Certificate**. Verify the displayed SHA-256 leaf-certificate fingerprint out of band before confirming; the certificate is pinned to that connection only. Do not use an insecure TLS bypass.

### The certificate does not match the trusted certificate

Follow the [Certificate mismatch](#certificate-mismatch) procedure. Re-trusting a certificate intentionally replaces the existing pin only after you confirm the newly displayed SHA-256 fingerprint.

### Live testing cannot reach the server

First verify that the VS Code host can reach the server over HTTPS and that its CA is trusted. The extension uses the Proxmox API below the server URL automatically, for example `/api2/json/cluster/resources`. Authentication still requires a read-only API token.

### Compilation fails

Confirm that Node.js and npm are available, remove an incomplete `node_modules/` directory, run `npm install`, and retry `npm run compile`.
