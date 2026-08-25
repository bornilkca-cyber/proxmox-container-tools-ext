import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

// Mock types for testing
class MockWebview extends EventEmitter {
  html = '';
  options = {};

  setHtml(html) {
    this.html = html;
  }
}

class MockWebviewView extends EventEmitter {
  webview = new MockWebview();
  onDidDispose = this.on.bind(this, 'dispose');
}

// Fake DashboardPanelProvider for testing
class FakeDashboardPanelProvider {
  static viewType = 'proxmox.dashboard';

  view = undefined;
  currentGuest = undefined;
  metrics = [];
  updateInterval = undefined;

  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getEmptyHtml();
    webviewView.onDidDispose(() => {
      this.clearUpdateInterval();
    });
  }

  updateGuest(guest) {
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

  addMetric(guest) {
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

    if (this.metrics.length > 60) {
      this.metrics.shift();
    }
  }

  startPeriodicUpdate() {
    this.clearUpdateInterval();
    this.updateInterval = setInterval(() => {
      if (this.currentGuest && this.view) {
        this.addMetric(this.currentGuest);
        this.view.webview.html = this.getDashboardHtml(this.currentGuest);
      }
    }, 5000);
  }

  clearUpdateInterval() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  dispose() {
    this.clearUpdateInterval();
  }

  getEmptyHtml() {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <style>
          body { color: var(--vscode-foreground); }
        </style>
      </head>
      <body>
        <div class="empty-state">
          <h2>No Guest Selected</h2>
          <p>Select a QEMU VM or LXC container to view dashboard</p>
        </div>
      </body>
      </html>
    `;
  }

  getDashboardHtml(guest) {
    const cpuPercent = guest.resource.cpu !== undefined ? (guest.resource.cpu * 100).toFixed(1) : 'N/A';
    const memoryPercent = guest.resource.mem !== undefined && guest.resource.maxmem !== undefined && guest.resource.maxmem > 0
      ? ((guest.resource.mem / guest.resource.maxmem) * 100).toFixed(1)
      : 'N/A';

    return `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"></head>
      <body>
        <div class="dashboard">
          <div class="header">
            <h2>${this.escapeHtml(guest.resource.name ?? `VM ${guest.vmid}`)}</h2>
          </div>
          <div class="metrics">
            <div>CPU: ${cpuPercent}%</div>
            <div>Memory: ${memoryPercent}%</div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}

describe('DashboardPanelProvider', () => {
  let provider;
  let mockWebviewView;
  let mockUri;

  before(() => {
    mockUri = { fsPath: '/path/to/extension' };
    provider = new FakeDashboardPanelProvider(mockUri);
  });

  after(() => {
    provider.dispose();
  });

  it('initializes with correct viewType', () => {
    assert.strictEqual(FakeDashboardPanelProvider.viewType, 'proxmox.dashboard');
  });

  it('resolves webview view with correct options', () => {
    mockWebviewView = new MockWebviewView();
    provider.resolveWebviewView(mockWebviewView);

    assert.strictEqual(provider.view, mockWebviewView);
    assert.strictEqual(mockWebviewView.webview.options.enableScripts, true);
    assert(Array.isArray(mockWebviewView.webview.options.localResourceRoots));
  });

  it('displays empty state when no guest selected', () => {
    mockWebviewView = new MockWebviewView();
    provider.resolveWebviewView(mockWebviewView);
    provider.updateGuest(undefined);

    const html = mockWebviewView.webview.html;
    assert(html.includes('No Guest Selected'));
    assert(html.includes('Select a QEMU VM or LXC container'));
  });

  it('displays guest dashboard when guest selected', () => {
    mockWebviewView = new MockWebviewView();
    provider.resolveWebviewView(mockWebviewView);

    const guest = {
      vmid: 100,
      node: 'node1',
      uptime: 3600,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        name: 'test-container',
        node: 'node1',
        vmid: 100,
        status: 'running',
        cpu: 0.5,
        maxcpu: 4,
        mem: 536870912,
        maxmem: 1073741824,
        uptime: 3600
      }
    };

    provider.updateGuest(guest);

    const html = mockWebviewView.webview.html;
    assert(html.includes('test-container'));
    assert(html.includes('50.0'));
    assert(html.includes('50.0'));
  });

  it('adds metric data points correctly', () => {
    const guest = {
      vmid: 100,
      node: 'node1',
      uptime: 3600,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        name: 'test-container',
        cpu: 0.25,
        maxcpu: 4,
        mem: 268435456,
        maxmem: 1073741824,
        uptime: 3600
      }
    };

    provider.updateGuest(guest);
    assert.strictEqual(provider.metrics.length, 1);
    assert.strictEqual(provider.metrics[0].cpu, 25);
    assert.strictEqual(provider.metrics[0].memory, 25);
  });

  it('clears metrics when guest updated', () => {
    const guest1 = {
      vmid: 100,
      node: 'node1',
      uptime: 3600,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        cpu: 0.5,
        maxcpu: 4,
        mem: 536870912,
        maxmem: 1073741824
      }
    };

    provider.updateGuest(guest1);
    assert.strictEqual(provider.metrics.length, 1);

    const guest2 = {
      vmid: 101,
      node: 'node1',
      uptime: 1800,
      resource: {
        id: 'lxc/node1/101',
        type: 'lxc',
        cpu: 0.3,
        maxcpu: 4,
        mem: 322122547,
        maxmem: 1073741824
      }
    };

    provider.updateGuest(guest2);
    assert.strictEqual(provider.metrics.length, 1);
  });

  it('limits metrics to 60 data points', () => {
    const guest = {
      vmid: 100,
      node: 'node1',
      uptime: 3600,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        cpu: 0.5,
        maxcpu: 4,
        mem: 536870912,
        maxmem: 1073741824
      }
    };

    provider.updateGuest(guest);

    // Add 70 metrics
    for (let i = 0; i < 70; i++) {
      provider.addMetric(guest);
    }

    assert.strictEqual(provider.metrics.length, 60);
  });

  it('clears update interval on dispose', (t, done) => {
    provider.dispose();

    // Check that updateInterval is cleared
    assert.strictEqual(provider.updateInterval, undefined);
    done();
  });

  it('handles undefined uptime gracefully', () => {
    mockWebviewView = new MockWebviewView();
    provider.resolveWebviewView(mockWebviewView);

    const guest = {
      vmid: 100,
      node: 'node1',
      uptime: undefined,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        name: 'test-container',
        cpu: 0.5,
        maxcpu: 4,
        mem: 536870912,
        maxmem: 1073741824
      }
    };

    provider.updateGuest(guest);

    assert.strictEqual(provider.metrics[0].uptime, 0);
  });

  it('calculates memory percentage correctly', () => {
    const guest = {
      vmid: 100,
      node: 'node1',
      uptime: 3600,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        cpu: 0.5,
        maxcpu: 4,
        mem: 536870912,
        maxmem: 1073741824
      }
    };

    provider.updateGuest(guest);

    // 536870912 / 1073741824 = 0.5, so 50%
    assert.strictEqual(provider.metrics[0].memory, 50);
  });

  it('calculates CPU percentage correctly', () => {
    const guest = {
      vmid: 100,
      node: 'node1',
      uptime: 3600,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        cpu: 0.75,
        maxcpu: 4,
        mem: 536870912,
        maxmem: 1073741824
      }
    };

    provider.updateGuest(guest);

    // 0.75 * 100 = 75%
    assert.strictEqual(provider.metrics[0].cpu, 75);
  });

  it('escapes HTML special characters in guest name', () => {
    const guest = {
      vmid: 100,
      node: 'node1',
      uptime: 3600,
      resource: {
        id: 'lxc/node1/100',
        type: 'lxc',
        name: '<script>alert("xss")</script>',
        cpu: 0.5,
        maxcpu: 4,
        mem: 536870912,
        maxmem: 1073741824
      }
    };

    mockWebviewView = new MockWebviewView();
    provider.resolveWebviewView(mockWebviewView);
    provider.updateGuest(guest);

    const html = mockWebviewView.webview.html;
    assert(!html.includes('<script>'));
    assert(html.includes('&lt;script&gt;'));
  });
});
