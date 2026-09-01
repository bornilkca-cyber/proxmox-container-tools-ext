/**
 * Shared formatting helpers and CSS used by the guest details and dashboard webviews.
 * Keeping a single implementation avoids the two panels drifting out of sync.
 */

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Serializes a value for embedding directly in an inline <script> block as a JS literal.
 * Unlike escapeHtml(), this must NOT HTML-entity-escape quotes/ampersands, or the
 * resulting text stops being valid JavaScript. Only "<" is escaped (as \u003c) to
 * prevent a "</script>" sequence in the data from closing the script tag early.
 */
export function toInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) {
    return 'N/A';
  }
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Compact uptime formatter (drops smaller units once a larger one is present).
 * Used where space is limited, e.g. the guest details header.
 */
export function formatUptimeCompact(seconds?: number): string {
  if (seconds === undefined) {
    return 'N/A';
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

/**
 * Full uptime formatter that always shows days/hours/minutes.
 * Used in the dashboard where a stable-width value avoids layout jitter.
 */
export function formatUptimeFull(seconds?: number): string {
  if (seconds === undefined) {
    return 'N/A';
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

export function getStatusColor(status?: string): string {
  return status === 'running' ? '#51cf66' : status === 'stopped' ? '#ff6b6b' : '#ffd43b';
}

export const EMPTY_STATE_CSS = `
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    margin: 0;
    padding: 20px;
  }
  .empty-state {
    text-align: center;
    color: var(--vscode-descriptionForeground);
    margin-top: 40px;
  }
  .empty-state h2 {
    margin: 0 0 10px 0;
    font-size: 16px;
    font-weight: 500;
  }
  .empty-state p {
    margin: 0;
    font-size: 13px;
  }
`;

export function getEmptyStateHtml(message: string): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <style>${EMPTY_STATE_CSS}</style>
    </head>
    <body>
      <div class="empty-state">
        <h2>No Guest Selected</h2>
        <p>${escapeHtml(message)}</p>
      </div>
    </body>
    </html>
  `;
}
