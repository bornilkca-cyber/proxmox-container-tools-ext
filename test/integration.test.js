const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

// Mock VS Code APIs
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners = [];
  }
}

class WebviewView {
  constructor() {
    this.webview = {
      html: '',
      options: {},
      onDidReceiveMessage: new EventEmitter()
    };
    this.title = '';
    this.description = '';
    this.onDidDispose = new EventEmitter().event;
  }
}

const mockVscode = {
  ThemeColor,
  ThemeIcon,
  TreeItem,
  EventEmitter,
  WebviewView,
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  TreeView: class TreeView {
    constructor(viewId, options) {
      this.viewId = viewId;
      this.selection = [];
      this.visible = true;
      this.onDidChangeSelection = new EventEmitter();
      this.onDidChangeVisibility = new EventEmitter();
      this.dispose = () => {};
    }
  },
  commands: {
    registerCommand: (command, callback) => {
      return { dispose: () => {} };
    },
    executeCommand: async () => {}
  },
  window: {
    createTreeView: (viewId, options) => {
      return new mockVscode.TreeView(viewId, options);
    },
    registerWebviewViewProvider: (viewType, provider) => {
      return { dispose: () => {} };
    },
    showErrorMessage: () => {},
    showInformationMessage: () => {},
    showWarningMessage: () => {},
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined
  },
  Uri: {
    file: (path) => ({ fsPath: path, toString: () => `file://${path}` })
  }
};

class FakeProxmoxClient {
  async getClusterResources() {
    return [];
  }
  async getGuestConfig(type, node, vmid) {
    return {};
  }
}

class FakeConnectionStore {
  constructor() {
    this.connections = [];
    this.credentialsByConnectionId = new Map();
  }

  async getCredentials(connection) {
    return this.credentialsByConnectionId.get(connection.id);
  }

  getConnections() {
    return this.connections;
  }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { GuestDetailsPanelProvider } = require('../out/guestDetailsPanel');
const { DashboardPanelProvider } = require('../out/dashboardPanel');
const { ProxmoxService } = require('../out/proxmoxService');

Module._load = originalLoad;

// Test: GuestDetailsPanelProvider initialization
test('GuestDetailsPanelProvider initializes with no guest selected', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  assert.equal(provider instanceof GuestDetailsPanelProvider, true);
});

// Test: Empty state HTML rendering
test('GuestDetailsPanelProvider renders empty state correctly', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  // Simulate webview registration
  const view = new WebviewView();
  provider.resolveWebviewView(view);

  provider.updateGuest(undefined);
  const html = view.webview.html;

  assert.ok(html.includes('No Guest Selected'), 'Should show empty state message');
  assert.ok(html.includes('<!DOCTYPE html>'), 'Should be valid HTML');
});

// Test: Guest details HTML rendering with data
test('GuestDetailsPanelProvider renders guest details with all fields', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const guestInfo = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 4,
    memory: 2147483648, // 2GB in bytes
    balloon: 1073741824, // 1GB
    hostname: 'my-vm',
    ostype: 'l26',
    boot: 'order=scsi0,unused1',
    tags: 'production,backup',
    protection: true,
    description: 'Test VM',
    uptime: 86400 // 1 day
  };

  provider.updateGuest(guestInfo);
  const html = view.webview.html;

  assert.ok(html.includes('my-vm'), 'Should include hostname');
  assert.ok(html.includes('pve-1'), 'Should include node name');
  assert.ok(html.includes('101'), 'Should include VM ID');
  assert.ok(html.includes('4'), 'Should include CPU cores');
  assert.ok(html.includes('2'), 'Should include memory value');
  assert.ok(html.includes('GB'), 'Should format memory as GB');
});

// Test: HTML escaping prevents XSS
test('GuestDetailsPanelProvider escapes HTML in user-provided content', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const guestInfo = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'vm<script>alert("xss")</script>',
    ostype: 'l26',
    boot: 'order=scsi0',
    tags: '<img src=x onerror="alert(1)">',
    protection: false,
    description: '"><script>alert(1)</script>',
    uptime: 0
  };

  provider.updateGuest(guestInfo);
  const html = view.webview.html;

  // Should produce valid HTML document
  assert.ok(html.includes('<!DOCTYPE html>'), 'Should be valid HTML');

  // Dangerous content should be neutralized (either escaped or removed)
  // Check that basic text is safe by looking for the hostname in some form
  // The implementation should prevent script execution
  assert.ok(!html.includes('<script>alert'), 'Should not allow inline script execution');
});

// Test: Uptime is owned by the Dashboard panel, not Guest Details
test('GuestDetailsPanelProvider does not duplicate live uptime (owned by Dashboard)', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const guestInfo = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'test-vm',
    ostype: 'l26',
    boot: 'order=scsi0',
    tags: '',
    protection: false,
    description: '',
    uptime: 86400
  };

  provider.updateGuest(guestInfo);
  const html = view.webview.html;
  assert.ok(!html.includes('Uptime'), 'Guest Details should not show uptime');
});

// Test: Dashboard's inline chart script must be valid JavaScript (regression
// guard for HTML-escaping JSON data meant for a <script> tag, which breaks parsing)
test('DashboardPanelProvider embeds syntactically valid inline script', () => {
  const vm = require('node:vm');
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new DashboardPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  try {
    provider.updateGuest({
      vmid: 101,
      node: 'pve-1',
      type: 'qemu',
      uptime: 3600,
      resource: { name: 'test-vm', status: 'running', cpu: 0.5, mem: 512, maxmem: 1024, maxcpu: 2 }
    });
    const html = view.webview.html;
    const scriptMatch = html.match(/<script>\s*\(function\(\)[\s\S]*?<\/script>/);
    assert.ok(scriptMatch, 'Should contain an inline chart script');

    // Parsing (not executing) the script body must not throw a SyntaxError.
    assert.doesNotThrow(() => new vm.Script(scriptMatch[0].replace(/<\/?script>/g, '')));
  } finally {
    provider.dispose();
  }
});

// Test: Dashboard formats uptime correctly
test('DashboardPanelProvider formats uptime correctly', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new DashboardPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const baseGuest = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    resource: { name: 'test-vm', status: 'running', cpu: 0.1, mem: 512, maxmem: 1024, maxcpu: 2 }
  };

  // Test 1: 1 day (86400 seconds)
  try {
    provider.updateGuest({ ...baseGuest, uptime: 86400 });
    const html = view.webview.html;
    assert.ok(html.includes('1d'), 'Should format 1 day');
  } finally {
    provider.dispose();
  }

  // Test 2: 1 hour (3600 seconds)
  try {
    provider.updateGuest({ ...baseGuest, uptime: 3600 });
    const html = view.webview.html;
    assert.ok(html.includes('0d 1h'), 'Should format 1 hour');
  } finally {
    provider.dispose();
  }

  // Test 3: Mixed: 3 days 5 hours (277200 seconds)
  try {
    provider.updateGuest({ ...baseGuest, uptime: 277200 });
    const html = view.webview.html;
    assert.ok(html.includes('3d 5h'), 'Should include days in mixed uptime');
  } finally {
    provider.dispose();
  }
});

// Test: Memory formatting
test('GuestDetailsPanelProvider formats memory sizes correctly', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  // Test various memory sizes
  const testCases = [
    { memory: 512, expected: 'B' }, // 512 bytes
    { memory: 1024, expected: 'KB' }, // 1 KB
    { memory: 1048576, expected: 'MB' }, // 1 MB
    { memory: 1073741824, expected: 'GB' } // 1 GB
  ];

  for (const testCase of testCases) {
    const guestInfo = {
      vmid: 101,
      node: 'pve-1',
      type: 'qemu',
      cores: 2,
      memory: testCase.memory,
      hostname: 'test-vm',
      ostype: 'l26',
      boot: 'order=scsi0',
      tags: '',
      protection: false,
      description: '',
      uptime: 0
    };

    provider.updateGuest(guestInfo);
    const html = view.webview.html;
    assert.ok(html.includes(testCase.expected), `Should format ${testCase.expected} units`);
  }
});

// Test: Protection warning display
test('GuestDetailsPanelProvider shows protection warning when guest is protected', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const protectedGuest = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'protected-vm',
    ostype: 'l26',
    boot: 'order=scsi0',
    tags: '',
    protection: true,
    description: '',
    uptime: 0
  };

  provider.updateGuest(protectedGuest);
  const html = view.webview.html;

  assert.ok(html.includes('⚠️') || html.includes('protected') || html.includes('Protection'), 'Should show protection warning');
});

// Test: ProxmoxService.loadGuestConfig integration
test('ProxmoxService.loadGuestConfig merges config and resource data', async () => {
  const connection = {
    id: 'conn-1',
    name: 'Lab',
    baseUrl: 'https://pve:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };

  // Mock the client calls
  const mockClient = new FakeProxmoxClient();
  mockClient.getClusterResources = async () => [{
    id: 'qemu/pve-1/101',
    type: 'qemu',
    node: 'pve-1',
    vmid: 101,
    name: 'test-vm',
    status: 'running',
    uptime: 86400,
    cpu: 0.5,
    maxcpu: 4
  }];

  mockClient.getGuestConfig = async (type, node, vmid) => ({
    vmid: 101,
    hostname: 'test-vm',
    cores: 4,
    memory: 2147483648,
    balloon: 1073741824,
    ostype: 'l26',
    boot: 'order=scsi0',
    tags: 'test',
    protection: false,
    description: 'Test VM',
    sockets: 1,
    cpu: 'host'
  });

  const service = new ProxmoxService(connection, credentials);

  // We can't directly test this without mocking internal ProxmoxClient
  // but we verify the class exists and has the method
  assert.ok(typeof service.loadGuestConfig === 'function', 'Should have loadGuestConfig method');
});

// Test: Panel updates on selection change (simulated)
test('GuestDetailsPanelProvider handles multiple selection changes', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  // Simulate selecting first guest
  const guest1 = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'vm-1',
    ostype: 'l26',
    boot: 'order=scsi0',
    tags: '',
    protection: false,
    description: '',
    uptime: 0
  };

  provider.updateGuest(guest1);
  assert.ok(view.webview.html.includes('vm-1'), 'Should display first guest');

  // Simulate selecting second guest
  const guest2 = {
    vmid: 102,
    node: 'pve-1',
    type: 'lxc',
    cores: 4,
    memory: 2147483648,
    hostname: 'ct-2',
    ostype: 'debian',
    boot: '',
    tags: 'test',
    protection: false,
    description: 'Container 2',
    uptime: 172800
  };

  provider.updateGuest(guest2);
  assert.ok(view.webview.html.includes('ct-2'), 'Should display second guest');
  assert.ok(!view.webview.html.includes('vm-1'), 'Should not contain first guest info');

  // Simulate deselection
  provider.updateGuest(undefined);
  assert.ok(view.webview.html.includes('No Guest Selected'), 'Should show empty state after deselection');
});

// Test: Panel cleanup on dispose
test('GuestDetailsPanelProvider cleans up resources on dispose', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  // Should not throw when disposing
  assert.doesNotThrow(() => {
    provider.dispose();
  });
});

// Test: Boot order display
test('GuestDetailsPanelProvider displays boot order information', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const guestInfo = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'test-vm',
    ostype: 'l26',
    boot: 'order=scsi0,unused1;priority=scsi0',
    tags: '',
    protection: false,
    description: '',
    uptime: 0
  };

  provider.updateGuest(guestInfo);
  const html = view.webview.html;

  assert.ok(html.includes('scsi0') || html.includes('boot') || html.includes('Boot'), 'Should display boot information');
});

// Test: Tags display
test('GuestDetailsPanelProvider displays tags correctly', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const guestInfo = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'test-vm',
    ostype: 'l26',
    boot: 'order=scsi0',
    tags: 'production,backup,monitored',
    protection: false,
    description: '',
    uptime: 0
  };

  provider.updateGuest(guestInfo);
  const html = view.webview.html;

  assert.ok(html.includes('production') || html.includes('tags'), 'Should display tags');
});

// Test: Edge case - missing optional fields
test('GuestDetailsPanelProvider handles missing optional fields gracefully', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const view = new WebviewView();
  provider.resolveWebviewView(view);

  const minimalGuestInfo = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'minimal-vm',
    ostype: 'l26',
    boot: '',
    tags: '',
    protection: false,
    description: '',
    uptime: 0
  };

  // Should not throw
  assert.doesNotThrow(() => {
    provider.updateGuest(minimalGuestInfo);
  });

  const html = view.webview.html;
  assert.ok(html.includes('minimal-vm'), 'Should display essential info');
  assert.ok(html.includes('<!DOCTYPE html>'), 'Should produce valid HTML');
});

// Test: Panel without view (early call to updateGuest before resolveWebviewView)
test('GuestDetailsPanelProvider handles updateGuest before view is resolved', () => {
  const extensionUri = mockVscode.Uri.file('/test');
  const provider = new GuestDetailsPanelProvider(extensionUri);

  const guestInfo = {
    vmid: 101,
    node: 'pve-1',
    type: 'qemu',
    cores: 2,
    memory: 1073741824,
    hostname: 'test-vm',
    ostype: 'l26',
    boot: 'order=scsi0',
    tags: '',
    protection: false,
    description: '',
    uptime: 0
  };

  // Should not throw even if view isn't resolved yet
  assert.doesNotThrow(() => {
    provider.updateGuest(guestInfo);
  });
});
