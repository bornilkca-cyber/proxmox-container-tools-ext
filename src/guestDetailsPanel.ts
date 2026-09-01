import * as vscode from 'vscode';
import { GuestDetailInfo } from './proxmoxTypes';
import { escapeHtml, formatBytes, getEmptyStateHtml } from './webviewCommon';

/**
 * Provides a webview panel displaying detailed guest configuration information.
 * Updates dynamically when the user selects a different guest in the tree view.
 */
export class GuestDetailsPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'proxmox.guestDetails';

  private view?: vscode.WebviewView;
  private currentGuest?: GuestDetailInfo;
  private loadingAbortController?: AbortController;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): Thenable<void> | void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: false,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getEmptyHtml();
  }

  /**
   * Update the panel with guest configuration details.
   * Handles loading state and error cases gracefully.
   */
  updateGuest(guest: GuestDetailInfo | undefined): void {
    this.currentGuest = guest;

    if (!this.view) {
      return;
    }

    if (guest === undefined) {
      this.view.webview.html = this.getEmptyHtml();
      return;
    }

    this.view.webview.html = this.getGuestHtml(guest);
  }

  /**
   * Cancel any in-flight config loading.
   */
  dispose(): void {
    this.loadingAbortController?.abort();
  }

  private getEmptyHtml(): string {
    return getEmptyStateHtml('Select a QEMU VM or LXC container to view details');
  }

  private getGuestHtml(guest: GuestDetailInfo): string {
    const statusColor = guest.status === 'running'
      ? 'var(--vscode-testing-iconPassed)'
      : guest.status === 'stopped'
        ? 'var(--vscode-testing-iconFailed)'
        : 'var(--vscode-testing-iconSkipped)';

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <style>
          * {
            box-sizing: border-box;
          }
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 8px;
            font-size: 12px;
            line-height: 1.4;
          }
          .header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 2px 6px;
            border-radius: 3px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 10px;
            font-weight: 500;
            text-transform: uppercase;
            white-space: nowrap;
            flex-shrink: 0;
          }
          .status-dot {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background-color: ${statusColor};
          }
          .guest-name {
            font-size: 12px;
            font-weight: 600;
            margin: 0;
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .section {
            margin-bottom: 8px;
          }
          .section-title {
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            font-size: 10px;
            letter-spacing: 0.3px;
            margin: 6px 0 3px 0;
            padding-bottom: 2px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
          }
          .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2px 6px;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            gap: 4px;
            padding: 2px 0;
            font-size: 11px;
          }
          .info-row.full {
            grid-column: 1 / -1;
          }
          .info-label {
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
            font-size: 11px;
            min-width: fit-content;
          }
          .info-value {
            color: var(--vscode-foreground);
            font-weight: 500;
            word-break: break-word;
            text-align: right;
            flex: 1;
            min-width: 0;
            font-size: 11px;
          }
          .info-value.empty {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
          }
          .tag-list {
            display: flex;
            flex-wrap: wrap;
            gap: 3px;
            margin-top: 2px;
          }
          .tag {
            display: inline-block;
            padding: 1px 4px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 2px;
            font-size: 10px;
          }
          .disabled {
            opacity: 0.6;
            color: var(--vscode-descriptionForeground);
          }
          .description {
            margin-top: 2px;
            padding: 4px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 2px;
            font-size: 11px;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 60px;
            overflow-y: auto;
          }
          .warning {
            background-color: var(--vscode-editorWarning-background);
            color: var(--vscode-editorWarning-foreground);
            padding: 4px;
            border-radius: 2px;
            margin-top: 6px;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 4px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h2 class="guest-name">${escapeHtml(guest.name || `${guest.type.toUpperCase()} ${guest.vmid}`)}</h2>
          <div class="status-badge">
            <div class="status-dot"></div>
            ${escapeHtml(guest.status || 'unknown')}
          </div>
        </div>

        <div class="section">
          <div class="info-grid">
            <div class="info-row">
              <div class="info-label">Type:</div>
              <div class="info-value">${escapeHtml(guest.type.toUpperCase())}</div>
            </div>
            <div class="info-row">
              <div class="info-label">VMID:</div>
              <div class="info-value">${guest.vmid}</div>
            </div>
            <div class="info-row full">
              <div class="info-label">Node:</div>
              <div class="info-value">${escapeHtml(guest.node)}</div>
            </div>
          </div>
        </div>

        ${guest.cores || guest.memory ? `
        <div class="section">
          <div class="section-title">Resources</div>
          <div class="info-grid">
            ${guest.cores ? `
            <div class="info-row">
              <div class="info-label">Cores:</div>
              <div class="info-value">${guest.cores}</div>
            </div>
            ` : ''}
            ${guest.memory ? `
            <div class="info-row">
              <div class="info-label">Memory:</div>
              <div class="info-value">${formatBytes(guest.memory)}</div>
            </div>
            ` : ''}
            ${guest.cpulimit ? `
            <div class="info-row">
              <div class="info-label">CPU Limit:</div>
              <div class="info-value">${guest.cpulimit}</div>
            </div>
            ` : ''}
            ${guest.balloon ? `
            <div class="info-row">
              <div class="info-label">Balloon:</div>
              <div class="info-value">${formatBytes(guest.balloon)}</div>
            </div>
            ` : ''}
          </div>
        </div>
        ` : ''}

        ${guest.hostname || guest.ostype || guest.osrelease ? `
        <div class="section">
          <div class="section-title">System</div>
          <div class="info-grid">
            ${guest.hostname ? `
            <div class="info-row full">
              <div class="info-label">Host:</div>
              <div class="info-value">${escapeHtml(guest.hostname)}</div>
            </div>
            ` : ''}
            ${guest.ostype ? `
            <div class="info-row">
              <div class="info-label">OS:</div>
              <div class="info-value">${escapeHtml(guest.ostype)}</div>
            </div>
            ` : ''}
            ${guest.osrelease ? `
            <div class="info-row">
              <div class="info-label">Release:</div>
              <div class="info-value">${escapeHtml(guest.osrelease)}</div>
            </div>
            ` : ''}
          </div>
        </div>
        ` : ''}

        ${guest.boot || guest.onboot !== undefined ? `
        <div class="section">
          <div class="section-title">Boot</div>
          <div class="info-grid">
            ${guest.boot ? `
            <div class="info-row full">
              <div class="info-label">Order:</div>
              <div class="info-value">${escapeHtml(guest.boot)}</div>
            </div>
            ` : ''}
            ${guest.onboot !== undefined ? `
            <div class="info-row">
              <div class="info-label">Auto-start:</div>
              <div class="info-value ${guest.onboot === 0 ? 'disabled' : ''}">${guest.onboot ? 'Yes' : 'No'}</div>
            </div>
            ` : ''}
          </div>
        </div>
        ` : ''}

        ${guest.tags ? `
        <div class="section">
          <div class="section-title">Tags</div>
          <div class="tag-list">
            ${guest.tags.split(';').map(tag => `<div class="tag">${escapeHtml(tag.trim())}</div>`).join('')}
          </div>
        </div>
        ` : ''}

        ${guest.description ? `
        <div class="section">
          <div class="section-title">Notes</div>
          <div class="description">${escapeHtml(guest.description)}</div>
        </div>
        ` : ''}

        ${guest.protection ? `
        <div class="warning">
          <span>⚠️</span>
          <span>Protected from changes</span>
        </div>
        ` : ''}
      </body>
      </html>
    `;
  }
}
