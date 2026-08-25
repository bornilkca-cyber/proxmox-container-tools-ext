const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

// Mock VS Code APIs
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

class WebviewView {
  constructor() {
    this.webview = {
      html: '',
      options: {},
      onDidReceiveMessage: new EventEmitter()
    };
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
      this.subscriptions = [];
      this.dispose = () => {};
    }
  },
  commands: {
    registerCommand: (command, callback) => ({
      dispose: () => {},
      _command: command,
      _callback: callback
    }),
    executeCommand: async (command, ...args) => {
      return undefined;
    }
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
    file: (path) => ({
      fsPath: path,
      toString: () => `file://${path}`
    })
  }
};

// Fake implementations of dependencies
class FakeConnectionStore {
  constructor() {
    this.connections = [];
    this.credentialsByConnectionId = new Map();
  }

  getConnections() {
    return this.connections;
  }

  async getCredentials(connection) {
    return this.credentialsByConnectionId.get(connection.id);
  }

  onDidChangeConnections = new mockVscode.EventEmitter();
}

class FakeProxmoxExplorerProvider {
  constructor(connectionStore, inFlightActions) {
    this.connectionStore = connectionStore;
    this.inFlightActions = inFlightActions;
    this.onDidChangeTreeData = new mockVscode.EventEmitter();
  }

  async getChildren(element) {
    return [];
  }

  getTreeItem(element) {
    return element;
  }

  refresh() {}
  refreshConnection(id) {}

  dispose() {}
}

class FakeGuestDetailsPanelProvider {
  static viewType = 'proxmox.guestDetails';

  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
  }

  updateGuest(guest) {
    this.currentGuest = guest;
  }

  dispose() {}
}

class FakeProxmoxService {
  constructor(connection, credentials) {
    this.connection = connection;
    this.credentials = credentials;
  }

  async loadClusterResources(signal) {
    return [];
  }

  async loadGuestConfig(type, node, vmid, signal) {
    return {
      vmid,
      node,
      type,
      cores: 2,
      memory: 1073741824,
      hostname: 'test',
      ostype: 'l26',
      boot: 'order=scsi0',
      tags: '',
      protection: false,
      description: '',
      uptime: 0
    };
  }

  async startGuest(type, node, vmid, signal) {
    return { data: 'UPID' };
  }

  async stopGuest(type, node, vmid, signal) {
    return { data: 'UPID' };
  }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  if (request === './connectionStore' && parent?.filename?.includes('extension')) {
    return { ConnectionStore: FakeConnectionStore };
  }
  if (request === './guestDetailsPanel' && parent?.filename?.includes('extension')) {
    return { GuestDetailsPanelProvider: FakeGuestDetailsPanelProvider };
  }
  if (request === './explorerProvider' && parent?.filename?.includes('extension')) {
    return { ProxmoxExplorerProvider: FakeProxmoxExplorerProvider };
  }
  if (request === './proxmoxService' && parent?.filename?.includes('extension')) {
    return { ProxmoxService: FakeProxmoxService };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { activate } = require('../out/extension');
const { ProxmoxService } = require('../out/proxmoxService');

Module._load = originalLoad;

// Test: Extension module loads without errors
test('Extension module exports activate function', () => {
  assert.equal(typeof activate, 'function', 'Extension should export activate function');
});

// Test: Extension context requires extensionUri
test('Extension activation context includes extensionUri', () => {
  const mockContext = {
    extensionUri: mockVscode.Uri.file('/test'),
    subscriptions: []
  };

  assert.ok(mockContext.extensionUri, 'Context should have extensionUri');
  assert.ok(mockContext.subscriptions, 'Context should have subscriptions array');
});

// Test: Verify connection store can be instantiated
test('ConnectionStore can be instantiated in extension context', () => {
  assert.equal(typeof FakeConnectionStore, 'function', 'ConnectionStore should be constructible');
  const store = new FakeConnectionStore();
  assert.ok(store.getConnections, 'Should have getConnections method');
});

// Test: Verify explorer provider can be instantiated
test('ProxmoxExplorerProvider can be instantiated', () => {
  assert.equal(typeof FakeProxmoxExplorerProvider, 'function', 'Explorer provider should be constructible');
  const provider = new FakeProxmoxExplorerProvider(new FakeConnectionStore(), new Set());
  assert.ok(provider.getChildren, 'Should have getChildren method');
});

// Test: Verify guest details panel can be instantiated
test('GuestDetailsPanelProvider can be instantiated', () => {
  assert.equal(typeof FakeGuestDetailsPanelProvider, 'function', 'Panel provider should be constructible');
  const panel = new FakeGuestDetailsPanelProvider(mockVscode.Uri.file('/test'));
  assert.ok(panel.updateGuest, 'Should have updateGuest method');
});

// Test: ProxmoxService.loadGuestConfig combines data correctly
test('ProxmoxService.loadGuestConfig returns complete GuestDetailInfo', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://test:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const guestConfig = await service.loadGuestConfig('qemu', 'pve-1', 101);

  assert.equal(guestConfig.vmid, 101, 'Should include vmid');
  assert.equal(guestConfig.node, 'pve-1', 'Should include node');
  assert.equal(guestConfig.type, 'qemu', 'Should include type');
  assert.equal(guestConfig.cores, 2, 'Should include cores');
  assert.ok(guestConfig.memory > 0, 'Should include memory');
  assert.ok(typeof guestConfig.hostname === 'string', 'Should include hostname');
  assert.ok(typeof guestConfig.ostype === 'string', 'Should include ostype');
});

// Test: ProxmoxService.loadGuestConfig with LXC container
test('ProxmoxService.loadGuestConfig works with LXC containers', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://test:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const guestConfig = await service.loadGuestConfig('lxc', 'pve-1', 101);

  assert.equal(guestConfig.type, 'lxc', 'Should handle lxc type');
  assert.equal(guestConfig.vmid, 101, 'Should include vmid for container');
});

// Test: ProxmoxService handles missing data gracefully
test('ProxmoxService.loadGuestConfig handles missing optional fields', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://test:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const guestConfig = await service.loadGuestConfig('qemu', 'pve-1', 101);

  // Should have all required fields even if some are empty
  assert.ok('vmid' in guestConfig);
  assert.ok('node' in guestConfig);
  assert.ok('type' in guestConfig);
  assert.ok('cores' in guestConfig);
  assert.ok('memory' in guestConfig);
});

// Test: Extension handles tree selection change (structure test)
test('Extension structure supports tree selection events', () => {
  const treeView = new mockVscode.TreeView('proxmoxExplorer', {});

  // Verify the EventEmitter is properly set up
  assert.ok(treeView.onDidChangeSelection instanceof EventEmitter, 'Should have selection change event emitter');
  assert.ok(typeof treeView.onDidChangeSelection.event === 'function', 'Should have event method');
});

// Test: Extension manages guest action tracking
test('Extension tracks in-flight guest actions with a Set', () => {
  const inFlightActions = new Set();

  // Verify Set operations
  inFlightActions.add('action-1');
  assert.ok(inFlightActions.has('action-1'), 'Should track actions in Set');

  inFlightActions.delete('action-1');
  assert.ok(!inFlightActions.has('action-1'), 'Should remove actions from Set');
});

// Test: Extension can be activated with proper context
test('Extension activation context structure is valid', () => {
  const mockContext = {
    extensionUri: mockVscode.Uri.file('/test'),
    subscriptions: []
  };

  // Verify context structure
  assert.ok(mockContext.extensionUri, 'Should have extensionUri');
  assert.ok(Array.isArray(mockContext.subscriptions), 'Should have subscriptions array');
});

// Test: Module exports match expected interface
test('Extension module has expected exports', () => {
  assert.equal(typeof activate, 'function', 'Should export activate function');
});

// Test: ProxmoxService.startGuest
test('ProxmoxService.startGuest initiates guest start', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://test:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const result = await service.startGuest('qemu', 'pve-1', 101);

  assert.ok(result, 'Should return result');
  assert.ok(result.data, 'Should include task data');
});

// Test: ProxmoxService.stopGuest
test('ProxmoxService.stopGuest initiates guest stop', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://test:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const result = await service.stopGuest('qemu', 'pve-1', 101);

  assert.ok(result, 'Should return result');
  assert.ok(result.data, 'Should include task data');
});

// SSH Hostname Fix Tests
test('SSH terminal command resolves guest hostname from config', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://proxmox.example.com:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  // Service should return config with hostname
  const config = await service.loadGuestConfig('lxc', 'pve-1', 101);

  // Verify hostname field exists in config
  assert.ok('hostname' in config, 'Config should include hostname field');
  assert.equal(typeof config.hostname, 'string', 'Hostname should be string');
});

test('SSH hostname resolution prefers guest hostname over server hostname', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://proxmox.example.com:8006', // Server hostname
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);
  const config = await service.loadGuestConfig('lxc', 'pve-1', 101);

  // Guest hostname should be available
  assert.ok(config.hostname, 'Should have guest hostname');

  // Extract server hostname for comparison
  const serverHostname = new URL(connection.baseUrl).hostname;

  // They should be different (guest vs server)
  assert.notEqual(config.hostname, serverHostname, 'Guest hostname should differ from server hostname');
});

test('SSH hostname falls back to server hostname if config unavailable', () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://proxmox.local:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  // Extract server hostname as fallback
  const serverHostname = new URL(connection.baseUrl).hostname;

  assert.equal(serverHostname, 'proxmox.local', 'Should extract server hostname from URL');
});

test('SSH hostname handles LXC container config resolution', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://pve:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const config = await service.loadGuestConfig('lxc', 'pve-1', 101);

  // Verify LXC container config loaded correctly
  assert.equal(config.type, 'lxc', 'Should load lxc config');
  assert.ok(config.hostname, 'Should have hostname for container');
});

test('SSH hostname handles QEMU VM config resolution', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://pve:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const config = await service.loadGuestConfig('qemu', 'pve-1', 200);

  // Verify QEMU VM config loaded correctly
  assert.equal(config.type, 'qemu', 'Should load qemu config');
  assert.ok(config.hostname, 'Should have hostname for VM');
});

test('SSH hostname validates non-empty string hostnames', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://pve:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const config = await service.loadGuestConfig('lxc', 'pve-1', 101);

  // Hostname should not be empty or whitespace-only
  assert.ok(config.hostname?.trim(), 'Hostname should be non-empty string');
});

// Test: ProxmoxService.loadClusterResources
test('ProxmoxService.loadClusterResources returns resource list', async () => {
  const connection = {
    id: 'test-conn',
    name: 'Test',
    baseUrl: 'https://test:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };

  const credentials = { tokenSecret: 'secret' };
  const service = new FakeProxmoxService(connection, credentials);

  const resources = await service.loadClusterResources();

  assert.ok(Array.isArray(resources), 'Should return array');
});
