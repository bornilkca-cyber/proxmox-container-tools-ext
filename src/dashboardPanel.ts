import * as vscode from 'vscode';
import { ClusterResource, GuestDetailInfo } from './proxmoxTypes';
import { escapeHtml, formatBytes, formatUptimeFull, getEmptyStateHtml, getStatusColor, toInlineScriptJson } from './webviewCommon';

/**
 * Resource metric for dashboard visualization.
 * Represents a data point for charts.
 */
interface ResourceMetric {
  timestamp: number;
  cpu: number; // 0-100%
  memory: number; // 0-100%
  uptime: number; // seconds
}

/**
 * Provides a webview panel displaying dashboard with resource charts.
 * Shows guest/node metrics with visual indicators.
 */
export class DashboardPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'proxmox.dashboard';

  private view?: vscode.WebviewView;
  private currentGuest?: GuestDetailInfo & { resource: ClusterResource };
  private metrics: ResourceMetric[] = [];
  private updateInterval?: NodeJS.Timeout;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): Thenable<void> | void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getEmptyHtml();

    // Clean up resources when view is hidden
    webviewView.onDidDispose(() => {
      this.clearUpdateInterval();
    });
  }

  /**
   * Update the dashboard with guest data.
   */
  updateGuest(guest: (GuestDetailInfo & { resource: ClusterResource }) | undefined): void {
    this.currentGuest = guest;
    this.metrics = [];

    if (!this.view) {
      return;
    }

    if (guest === undefined) {
      this.view.webview.html = this.getEmptyHtml();
      this.clearUpdateInterval();
      return;
    }

    this.addMetric(guest);
    this.view.webview.html = this.getDashboardHtml(guest);
    this.startPeriodicUpdate();
  }

  /**
   * Add a new metric data point.
   */
  private addMetric(guest: GuestDetailInfo & { resource: ClusterResource }): void {
    const cpuPercent = guest.resource.cpu !== undefined ? guest.resource.cpu * 100 : 0;
    const memoryPercent = guest.resource.mem !== undefined && guest.resource.maxmem !== undefined && guest.resource.maxmem > 0
      ? (guest.resource.mem / guest.resource.maxmem) * 100
      : 0;

    this.metrics.push({
      timestamp: Date.now(),
      cpu: Math.min(cpuPercent, 100),
      memory: Math.min(memoryPercent, 100),
      uptime: guest.uptime ?? 0
    });

    // Keep only last 60 data points (for reasonable chart size)
    if (this.metrics.length > 60) {
      this.metrics.shift();
    }
  }

  /**
   * Start periodic dashboard updates.
   */
  private startPeriodicUpdate(): void {
    this.clearUpdateInterval();

    this.updateInterval = setInterval(() => {
      if (this.currentGuest && this.view) {
        this.addMetric(this.currentGuest);
        // In a real implementation, this would fetch fresh data from Proxmox API
        this.view.webview.html = this.getDashboardHtml(this.currentGuest);
      }
    }, 5000); // Update every 5 seconds
  }

  /**
   * Clear the update interval.
   */
  private clearUpdateInterval(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.clearUpdateInterval();
  }

  private getEmptyHtml(): string {
    return getEmptyStateHtml('Select a QEMU VM or LXC container to view dashboard');
  }

  private getDashboardHtml(guest: GuestDetailInfo & { resource: ClusterResource }): string {
    const formatUptime = formatUptimeFull;

    const cpuPercent = guest.resource.cpu !== undefined ? (guest.resource.cpu * 100).toFixed(1) : 'N/A';
    const memoryPercent = guest.resource.mem !== undefined && guest.resource.maxmem !== undefined && guest.resource.maxmem > 0
      ? ((guest.resource.mem / guest.resource.maxmem) * 100).toFixed(1)
      : 'N/A';
    const status = guest.resource.status ?? 'unknown';
    const statusColor = getStatusColor(status);

    const metricsJson = toInlineScriptJson(this.metrics);
    const guestNameEscaped = escapeHtml(guest.resource.name ?? `VM ${guest.vmid}`);

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 12px;
          }
          .dashboard {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            padding-bottom: 8px;
          }
          .header h2 {
            font-size: 14px;
            font-weight: 600;
            margin: 0;
          }
          .status-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 500;
            background-color: ${statusColor}20;
            color: ${statusColor};
            border: 1px solid ${statusColor}40;
            text-transform: capitalize;
          }
          .metrics-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-bottom: 8px;
          }
          .metric-card {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            padding: 8px;
          }
          .metric-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .metric-value {
            font-size: 18px;
            font-weight: 600;
            font-family: monospace;
            margin-bottom: 4px;
          }
          .metric-bar {
            height: 4px;
            background-color: var(--vscode-editorWidget-border);
            border-radius: 2px;
            overflow: hidden;
          }
          .metric-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #51cf66 0%, #ffd43b 60%, #ff6b6b 100%);
            transition: width 0.3s ease;
          }
          .chart-container {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            padding: 8px;
            position: relative;
            height: 200px;
            margin-bottom: 8px;
          }
          .chart-title {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            font-size: 11px;
          }
          .info-item {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            padding: 8px;
          }
          .info-label {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 2px;
          }
          .info-value {
            font-family: monospace;
            color: var(--vscode-foreground);
            font-weight: 500;
          }
        </style>
      </head>
      <body>
        <div class="dashboard">
          <div class="header">
            <h2>${guestNameEscaped}</h2>
            <span class="status-badge">${escapeHtml(status)}</span>
          </div>

          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-label">CPU Usage</div>
              <div class="metric-value">${cpuPercent}%</div>
              <div class="metric-bar">
                <div class="metric-bar-fill" style="width: ${Math.min(parseFloat(cpuPercent as string), 100)}%"></div>
              </div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Memory Usage</div>
              <div class="metric-value">${memoryPercent}%</div>
              <div class="metric-bar">
                <div class="metric-bar-fill" style="width: ${Math.min(parseFloat(memoryPercent as string), 100)}%"></div>
              </div>
            </div>
          </div>

          <div class="chart-container">
            <div class="chart-title">CPU & Memory Trend (last 5 minutes)</div>
            <canvas id="trendChart"></canvas>
          </div>

          <div class="info-grid">
            <div class="info-item">
              <div class="info-label">Uptime</div>
              <div class="info-value">${formatUptime(guest.uptime)}</div>
            </div>
            <div class="info-item">
              <div class="info-label">RAM</div>
              <div class="info-value">${formatBytes(guest.resource.mem)} / ${formatBytes(guest.resource.maxmem)}</div>
            </div>
          </div>
        </div>

        <script>
          (function() {
            const metrics = ${metricsJson};
            if (metrics.length === 0) return;

            const ctx = document.getElementById('trendChart').getContext('2d');
            const labels = metrics.map((m, i) => {
              const date = new Date(m.timestamp);
              const minutes = String(date.getMinutes()).padStart(2, '0');
              const seconds = String(date.getSeconds()).padStart(2, '0');
              return i % 5 === 0 ? \`\${minutes}:\${seconds}\` : '';
            });

            new Chart(ctx, {
              type: 'line',
              data: {
                labels: labels,
                datasets: [
                  {
                    label: 'CPU %',
                    data: metrics.map(m => m.cpu),
                    borderColor: '#ff9999',
                    backgroundColor: 'rgba(255, 153, 153, 0.1)',
                    tension: 0.3,
                    fill: true,
                    pointRadius: 2,
                    pointBackgroundColor: '#ff9999',
                    yAxisID: 'y'
                  },
                  {
                    label: 'Memory %',
                    data: metrics.map(m => m.memory),
                    borderColor: '#66b3ff',
                    backgroundColor: 'rgba(102, 179, 255, 0.1)',
                    tension: 0.3,
                    fill: true,
                    pointRadius: 2,
                    pointBackgroundColor: '#66b3ff',
                    yAxisID: 'y'
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                  mode: 'index',
                  intersect: false
                },
                plugins: {
                  legend: {
                    display: true,
                    position: 'top',
                    labels: {
                      boxWidth: 12,
                      font: { size: 10 }
                    }
                  },
                  filler: {
                    propagate: true
                  }
                },
                scales: {
                  y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    min: 0,
                    max: 100,
                    ticks: {
                      stepSize: 20,
                      font: { size: 10 }
                    },
                    grid: {
                      drawBorder: false,
                      color: 'rgba(128, 128, 128, 0.25)'
                    }
                  },
                  x: {
                    ticks: {
                      font: { size: 9 }
                    },
                    grid: {
                      drawBorder: false,
                      display: true,
                      color: 'rgba(128, 128, 128, 0.12)'
                    }
                  }
                }
              }
            });
          })();
        </script>
      </body>
      </html>
    `;
  }
}
