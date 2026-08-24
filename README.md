# Proxmox Container Tools for VS Code

Manage Proxmox VE servers, QEMU virtual machines, and LXC containers from VS Code.

> **Project status:** Early MVP. The current build provides secure connection management, Proxmox inventory with read-only guest snapshots, confirmation-gated guest start/stop, automatic inventory refresh every 60 seconds, and an external-browser LXC xterm.js shell link.

## Contents

- [Overview](#overview)
- [Installation](#installation)
- [MVP scope](#mvp-scope)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Security and reliability](#security-and-reliability)
- [Acceptance criteria](#acceptance-criteria)
- [Open decisions](#open-decisions)

## Overview

Proxmox Container Tools is inspired by VS Code Container Tools. It aims to provide a focused management experience for Proxmox VE through the Proxmox VE HTTPS API, so common operational tasks can be handled without leaving the editor.

The project prioritizes read-only visibility, explicit power-operation confirmations, and secure credential handling.

## Installation

See [INSTALL.md](INSTALL.md) for prerequisites, source builds, VSIX installation, connection setup, and the read-only testing policy.

## MVP scope

The first release is expected to include:

- A TypeScript VS Code extension with standard linting, formatting, packaging, and test tooling.
- A connection command for a server URL, realm, username, and API token.
- Credential storage through VS Code `SecretStorage`; tokens must never be written to settings or logs.
- A typed client for authentication and the Proxmox VE inventory, guest action, and task-status endpoints.
- A Proxmox Explorer tree view containing connections, nodes, QEMU virtual machines, LXC containers, and storage.
- Read-only snapshot inventory beneath each QEMU virtual machine and LXC container.
- Guest status, node, CPU percentage/count, memory, and uptime information.
- Automatic inventory refresh every 60 seconds and when a connection is expanded.
- An SSH terminal action that pastes `ssh $USER@hostname` and waits for confirmation.
- Guarded start and stop commands with confirmation and task polling.
- API errors and operation progress in VS Code notifications and the Output channel.
- Unit tests for requests, response parsing, tree item state, and command behavior.

## Architecture

```text
VS Code commands and TreeDataProvider
		|
	Proxmox service layer
		|
	Typed Proxmox API client
		|
       Proxmox VE REST API
```

Proposed source structure:

```text
src/
  extension.ts          # Activation and command registration
  proxmoxClient.ts      # HTTP transport and authentication
  proxmoxTypes.ts       # API response and domain types
  proxmoxService.ts     # Operations used by the UI
  explorerProvider.ts   # Connection, node, and guest tree
  commands.ts           # Start, stop, restart, and refresh actions
test/
```

## Roadmap

### Phase 1: Foundation

- Scaffold the extension and configure linting, formatting, packaging, and testing.
- Confirm supported VS Code and Proxmox VE versions.
- Create a connection model and a typed HTTP client.

### Phase 2: Read-only Explorer

- Add connection management and refresh behavior.
- Load cluster resources and group them by node and guest type.
- Show useful context values and status icons.
- Handle unavailable nodes, expired tokens, and incomplete permissions.

### Phase 3: Guest Operations

- Add start, shutdown, stop, and restart commands.
- Require confirmation for power operations that can interrupt a guest.
- Poll task status and report completion or failure.
- Refresh affected tree items after each operation.

### Phase 4: Console and Operations

- Open VM and container consoles using supported Proxmox endpoints.
- Add snapshot creation/deletion, backups, storage usage, and task history.
- Add optional resource charts in a webview only where the tree view is insufficient.

### Phase 5: Release Quality

- Test against a disposable Proxmox environment and mocked API responses.
- Add accessibility labels, keyboard actions, and cancellation for long-running tasks.
- Package the extension, document permissions, and publish release notes.

## Security and reliability

- Prefer scoped Proxmox API tokens with the minimum required permissions.
- Use HTTPS and make certificate-validation behavior explicit. Never silently disable TLS verification.
- Store secrets only with `SecretStorage`.
- Redact authorization headers and token values from logs and error messages.
- Treat power operations as potentially disruptive and require confirmation.
- Respect Proxmox task identifiers and poll task status instead of assuming an HTTP response means completion.

## Acceptance criteria

- A user can add a Proxmox server and see its nodes and guests in the Explorer.
- Guest state is visible and can be refreshed without reloading VS Code.
- Start and stop work for supported guests, require confirmation, and show task completion or failure.
- Invalid credentials, permission failures, network failures, and self-signed certificates produce actionable errors.
- No credentials appear in settings, source control, telemetry, or logs.

## Open decisions

- Whether to support single-node installations first or cluster environments from the first release.
- Whether to support API tokens only initially or also username/password tickets.
- Whether console access belongs in the MVP or a later release.
- Whether the first release targets QEMU, LXC, or both.
