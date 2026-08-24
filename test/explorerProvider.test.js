const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

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

const mockVscode = {
  ThemeColor,
  ThemeIcon,
  TreeItem,
  EventEmitter,
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  }
};

class FakeProxmoxService {
  constructor(connection, credentials) {
    this.connection = connection;
    this.credentials = credentials;
  }

  loadClusterResources(signal) {
    return FakeProxmoxService.handlers.loadClusterResources(this.connection, this.credentials, signal);
  }

  loadStorage(node, signal) {
    return FakeProxmoxService.handlers.loadStorage(this.connection, this.credentials, node, signal);
  }

  loadSnapshots(type, node, vmid, signal) {
    return FakeProxmoxService.handlers.loadSnapshots(this.connection, this.credentials, type, node, vmid, signal);
  }
}

FakeProxmoxService.handlers = {
  loadClusterResources: async () => [],
  loadStorage: async () => [],
  loadSnapshots: async () => []
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  if (request === './proxmoxService' && parent?.filename?.endsWith('/out/explorerProvider.js')) {
    return { ProxmoxService: FakeProxmoxService };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { ProxmoxExplorerProvider } = require('../out/explorerProvider');
Module._load = originalLoad;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

function createConnectionStore(options = {}) {
  const connections = options.connections ?? [{
    id: 'connection-id',
    name: 'Lab',
    baseUrl: 'https://host:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  }];
  const credentialsByConnectionId = new Map(
    connections.map((connection) => [connection.id, { tokenSecret: 'secret' }])
  );

  return {
    connection: connections[0],
    connections,
    store: {
      getConnections: () => connections,
      getCredentials: async (connection) => credentialsByConnectionId.get(connection.id)
    }
  };
}

function setupClusterHandlers() {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-node-a', type: 'node', node: 'node-a' },
    { id: 'qemu-101', type: 'qemu', node: 'node-a', vmid: 101, name: 'vm-101', status: 'running', cpu: 0.3, maxcpu: 2 }
  ];
  FakeProxmoxService.handlers.loadStorage = async () => [];
}

async function getGuestItem(provider) {
  const rootItems = await provider.getChildren();
  const nodeItems = await provider.getChildren(rootItems[0]);
  const children = await provider.getChildren(nodeItems[0]);
  return children.find((item) => typeof item.id === 'string' && item.id.startsWith('guest:'));
}

async function getGuestItemForConnection(provider, connectionItem) {
  const nodeItems = await provider.getChildren(connectionItem);
  assert.ok(nodeItems.length > 0, 'Expected at least one node item.');
  const children = await provider.getChildren(nodeItems[0]);
  const guestItem = children.find((item) => typeof item.id === 'string' && item.id.startsWith('guest:'));
  assert.ok(guestItem, 'Expected a guest tree item for connection.');
  return guestItem;
}

test('reuses one in-flight snapshot request for duplicate expands', async () => {
  setupClusterHandlers();
  let snapshotCalls = 0;
  const snapshots = deferred();
  FakeProxmoxService.handlers.loadSnapshots = async () => {
    snapshotCalls += 1;
    return snapshots.promise;
  };

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const guestItem = await getGuestItem(provider);
    assert.ok(guestItem, 'Expected a guest tree item in test fixture.');

    const first = provider.getChildren(guestItem);
    const second = provider.getChildren(guestItem);
    await flushAsyncWork();

    assert.equal(snapshotCalls, 1);

    snapshots.resolve([{ name: 'snap-a', snaptime: 1_700_000_000, vmstate: 0 }]);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.length, 1);
    assert.equal(secondResult.length, 1);
    assert.equal(firstResult[0].label, 'snap-a');
    assert.equal(secondResult[0].label, 'snap-a');
  } finally {
    provider.dispose();
  }
});

test('assigns stable IDs to snapshot tree items', async () => {
  setupClusterHandlers();
  FakeProxmoxService.handlers.loadSnapshots = async () => [
    { name: 'snap-a', snaptime: 1_700_000_000, vmstate: 0 },
    { name: 'snap-b', snaptime: 1_700_000_100, vmstate: 0 }
  ];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const guestItem = await getGuestItem(provider);
    const snapshots = await provider.getChildren(guestItem);

    assert.deepEqual(snapshots.map((item) => item.id), [
      'snapshot:connection-id:node-a:qemu:101:snap-b',
      'snapshot:connection-id:node-a:qemu:101:snap-a'
    ]);
  } finally {
    provider.dispose();
  }
});

test('encodes node, guest, and storage ID components', async () => {
  const connection = {
    id: 'connection:with:colon',
    name: 'Lab',
    baseUrl: 'https://host:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node:resource', type: 'node', node: 'node:with:colon' },
    { id: 'guest:resource', type: 'qemu', node: 'node:with:colon', vmid: 101, name: 'vm-101', status: 'running', cpu: 0.3, maxcpu: 2 }
  ];
  FakeProxmoxService.handlers.loadStorage = async () => [{ storage: 'storage:with:colon', type: 'dir' }];

  const { store } = createConnectionStore({ connections: [connection] });
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodeItems = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodeItems[0]);

    assert.equal(nodeItems[0].id, 'node:connection%3Awith%3Acolon:node%3Awith%3Acolon');
    assert.equal(children.find((item) => item.resource)?.id, 'guest:connection%3Awith%3Acolon:guest%3Aresource');
    assert.ok(children.some((item) => item.id === 'storage:connection%3Awith%3Acolon:node%3Awith%3Acolon:storage%3Awith%3Acolon'));
  } finally {
    provider.dispose();
  }
});

test('does not clear another connection storage cache during refresh', async () => {
  const connectionA = {
    id: 'connection:prod',
    name: 'Lab A',
    baseUrl: 'https://host-a:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token-a'
  };
  const connectionB = {
    id: 'connection',
    name: 'Lab B',
    baseUrl: 'https://host-b:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token-b'
  };
  let storageCalls = 0;
  FakeProxmoxService.handlers.loadClusterResources = async (connection) => [{
    id: `node-${connection.id}`,
    type: 'node',
    node: connection.id === connectionA.id ? 'web' : 'prod:web'
  }];
  FakeProxmoxService.handlers.loadStorage = async () => {
    storageCalls += 1;
    return [{ storage: 'local', type: 'dir' }];
  };

  const { store } = createConnectionStore({ connections: [connectionA, connectionB] });
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItemA = rootItems.find((item) => item.id === connectionA.id);
    const connectionItemB = rootItems.find((item) => item.id === connectionB.id);
    const nodeItemsA = await provider.getChildren(connectionItemA);
    const nodeItemsB = await provider.getChildren(connectionItemB);
    await provider.getChildren(nodeItemsA[0]);
    await provider.getChildren(nodeItemsB[0]);
    assert.equal(storageCalls, 2);

    provider.refreshConnection(connectionB.id);
    await provider.getChildren(nodeItemsA[0]);

    assert.equal(storageCalls, 2, 'Refreshing connection B must preserve connection A storage cache.');
  } finally {
    provider.dispose();
  }
});

test('sorts guest names in natural numeric order', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-a', type: 'node', node: 'node-a' },
    { id: 'qemu-2', type: 'qemu', node: 'node-a', vmid: 2, name: 'vm-2' },
    { id: 'qemu-10', type: 'qemu', node: 'node-a', vmid: 10, name: 'vm-10' }
  ];
  FakeProxmoxService.handlers.loadStorage = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodes[0]);
    assert.deepEqual(children.filter((item) => item.resource).map((item) => item.label), ['vm-2', 'vm-10']);
  } finally {
    provider.dispose();
  }
});

test('deduplicates duplicate guest resources', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-a', type: 'node', node: 'node-a' },
    { id: 'qemu-101', type: 'qemu', node: 'node-a', vmid: 101, name: 'vm-101' },
    { id: 'qemu-101', type: 'qemu', node: 'node-a', vmid: 101, name: 'vm-101' }
  ];
  FakeProxmoxService.handlers.loadStorage = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodes[0]);
    const guests = children.filter((item) => item.resource);
    assert.equal(guests.length, 1);
  } finally {
    provider.dispose();
  }
});

test('shows an empty-state message when a connection has no nodes', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const children = await provider.getChildren(rootItems[0]);
    assert.equal(children.length, 1);
    assert.equal(children[0].label, 'No Proxmox nodes found.');
  } finally {
    provider.dispose();
  }
});

test('excludes guests without a valid node from the tree', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-a', type: 'node', node: 'node-a' },
    { id: 'qemu-invalid', type: 'qemu', vmid: 101, name: 'invalid-guest' }
  ];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    assert.deepEqual(nodes.map((item) => item.label), ['node-a']);
  } finally {
    provider.dispose();
  }
});

test('shows an empty-state message when a node has no guests or storage', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-empty', type: 'node', node: 'node-empty' }
  ];
  FakeProxmoxService.handlers.loadStorage = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodes[0]);
    assert.equal(children.length, 1);
    assert.equal(children[0].label, 'No guests or storage found.');
  } finally {
    provider.dispose();
  }
});

test('starts a fresh snapshot request after refresh version bump', async () => {
  setupClusterHandlers();
  let snapshotCalls = 0;
  const staleSnapshots = deferred();

  FakeProxmoxService.handlers.loadSnapshots = async () => {
    snapshotCalls += 1;
    if (snapshotCalls === 1) {
      return staleSnapshots.promise;
    }
    return [{ name: 'snap-new', snaptime: 1_700_000_500, vmstate: 0 }];
  };

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const guestItem = await getGuestItem(provider);
    assert.ok(guestItem, 'Expected a guest tree item in test fixture.');

    const staleRequest = provider.getChildren(guestItem);
    await flushAsyncWork();
    provider.refresh();
    const freshResult = await provider.getChildren(guestItem);

    assert.equal(snapshotCalls, 2);
    assert.equal(freshResult.length, 1);
    assert.equal(freshResult[0].label, 'snap-new');

    staleSnapshots.resolve([{ name: 'snap-old', snaptime: 1_700_000_000, vmstate: 0 }]);
    const staleResult = await staleRequest;
    assert.equal(staleResult.length, 1);
    assert.equal(staleResult[0].label, 'snap-new');

    const cached = await provider.getChildren(guestItem);
    assert.equal(snapshotCalls, 2);
    assert.equal(cached[0].label, 'snap-new');
  } finally {
    provider.dispose();
  }
});

test('stale node inventory requests do not render outdated tree data', async () => {
  const staleClusterResources = deferred();
  let clusterCalls = 0;

  FakeProxmoxService.handlers.loadClusterResources = async () => {
    clusterCalls += 1;
    if (clusterCalls === 1) {
      return staleClusterResources.promise;
    }
    return [
      { id: 'node-node-b', type: 'node', node: 'node-b' },
      { id: 'qemu-202', type: 'qemu', node: 'node-b', vmid: 202, name: 'vm-new', status: 'running', cpu: 0.4, maxcpu: 2 }
    ];
  };
  FakeProxmoxService.handlers.loadStorage = async () => [];
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItem = rootItems[0];

    const staleRequest = provider.getChildren(connectionItem);
    await flushAsyncWork();

    provider.refreshConnection(store.getConnections()[0].id);
    const freshNodes = await provider.getChildren(connectionItem);

    assert.equal(clusterCalls, 2);
    assert.equal(freshNodes.length, 1);
    assert.equal(freshNodes[0].label, 'node-b');

    staleClusterResources.resolve([
      { id: 'node-node-a', type: 'node', node: 'node-a' },
      { id: 'qemu-101', type: 'qemu', node: 'node-a', vmid: 101, name: 'vm-old', status: 'running', cpu: 0.2, maxcpu: 1 }
    ]);

    const staleNodes = await staleRequest;
    assert.equal(staleNodes.length, 1);
    assert.equal(staleNodes[0].label, 'node-b');
  } finally {
    provider.dispose();
  }
});

test('concurrent connection expands reuse one inventory request', async () => {
  const clusterResources = deferred();
  let clusterCalls = 0;

  FakeProxmoxService.handlers.loadClusterResources = async () => {
    clusterCalls += 1;
    return clusterResources.promise;
  };
  FakeProxmoxService.handlers.loadStorage = async () => [];
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItem = rootItems[0];

    const first = provider.getChildren(connectionItem);
    const second = provider.getChildren(connectionItem);
    await flushAsyncWork();

    assert.equal(clusterCalls, 1);

    clusterResources.resolve([
      { id: 'node-node-c', type: 'node', node: 'node-c' },
      { id: 'qemu-303', type: 'qemu', node: 'node-c', vmid: 303, name: 'vm-c', status: 'running', cpu: 0.5, maxcpu: 2 }
    ]);

    const [firstNodes, secondNodes] = await Promise.all([first, second]);
    assert.equal(firstNodes.length, 1);
    assert.equal(secondNodes.length, 1);
    assert.equal(firstNodes[0].label, 'node-c');
    assert.equal(secondNodes[0].label, 'node-c');
  } finally {
    provider.dispose();
  }
});

test('sequential connection expands reuse cached inventory until refresh', async () => {
  let clusterCalls = 0;
  FakeProxmoxService.handlers.loadClusterResources = async () => {
    clusterCalls += 1;
    return [
      { id: 'node-node-c', type: 'node', node: 'node-c' },
      { id: 'qemu-303', type: 'qemu', node: 'node-c', vmid: 303, name: 'vm-c', status: 'running', cpu: 0.5, maxcpu: 2 }
    ];
  };
  FakeProxmoxService.handlers.loadStorage = async () => [];
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItem = rootItems[0];

    const firstNodes = await provider.getChildren(connectionItem);
    const secondNodes = await provider.getChildren(connectionItem);

    assert.equal(clusterCalls, 1);
    assert.equal(firstNodes[0].label, 'node-c');
    assert.equal(secondNodes[0].label, 'node-c');
  } finally {
    provider.dispose();
  }
});

test('retries transient storage failures once', async () => {
  setupClusterHandlers();
  let storageCalls = 0;

  FakeProxmoxService.handlers.loadStorage = async () => {
    storageCalls += 1;
    if (storageCalls === 1) {
      throw new Error('The Proxmox request timed out.');
    }
    return [{ storage: 'local', type: 'dir', used: 1024, total: 4096, avail: 3072 }];
  };
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItem = rootItems[0];
    const nodeItems = await provider.getChildren(connectionItem);
    const nodeItem = nodeItems[0];

    const children = await provider.getChildren(nodeItem);
    const storageItem = children.find((item) => item.id === 'storage:connection-id:node-a:local');

    assert.equal(storageCalls, 2);
    assert.ok(storageItem, 'Expected storage item after transient retry success.');
  } finally {
    provider.dispose();
  }
});

test('hides non-transient storage failures when guests are available', async () => {
  setupClusterHandlers();
  let storageCalls = 0;

  FakeProxmoxService.handlers.loadStorage = async () => {
    storageCalls += 1;
    throw new Error('permission denied');
  };
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItem = rootItems[0];
    const nodeItems = await provider.getChildren(connectionItem);
    const nodeItem = nodeItems[0];

    const children = await provider.getChildren(nodeItem);

    assert.equal(storageCalls, 1);
    assert.ok(children.some((item) => typeof item.id === 'string' && item.id.startsWith('guest:')));
    assert.equal(children.some((item) => String(item.label).includes('Storage unavailable')), false);
  } finally {
    provider.dispose();
  }
});

test('shows a storage load diagnostic only when no guests are available', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-a', type: 'node', node: 'node-a' }
  ];
  FakeProxmoxService.handlers.loadStorage = async () => {
    throw new Error('permission denied');
  };
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodeItems = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodeItems[0]);

    assert.equal(children.length, 1);
    assert.equal(children[0].label, 'No guests found. Storage could not be loaded: permission denied');
  } finally {
    provider.dispose();
  }
});

test('does not render the legacy storage unavailable text for transient failures after retry', async () => {
  setupClusterHandlers();
  FakeProxmoxService.handlers.loadStorage = async () => {
    throw new Error('socket hang up');
  };
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodeItems = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodeItems[0]);

    assert.equal(children.some((item) => String(item.label).includes('Storage unavailable')), false);
    assert.ok(children.some((item) => typeof item.id === 'string' && item.id.startsWith('guest:')));
  } finally {
    provider.dispose();
  }
});

test('concurrent node expands reuse one storage request', async () => {
  setupClusterHandlers();
  const storageResources = deferred();
  let storageCalls = 0;

  FakeProxmoxService.handlers.loadStorage = async () => {
    storageCalls += 1;
    return storageResources.promise;
  };
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItem = rootItems[0];
    const nodeItems = await provider.getChildren(connectionItem);
    const nodeItem = nodeItems[0];

    const first = provider.getChildren(nodeItem);
    const second = provider.getChildren(nodeItem);
    await flushAsyncWork();

    assert.equal(storageCalls, 1);

    storageResources.resolve([{ storage: 'nfs', type: 'nfs', used: 2048, total: 8192, avail: 6144 }]);
    const [firstChildren, secondChildren] = await Promise.all([first, second]);

    const firstStorageItem = firstChildren.find((item) => item.id === 'storage:connection-id:node-a:nfs');
    const secondStorageItem = secondChildren.find((item) => item.id === 'storage:connection-id:node-a:nfs');
    assert.ok(firstStorageItem, 'Expected storage item in first node expansion.');
    assert.ok(secondStorageItem, 'Expected storage item in second node expansion.');
  } finally {
    provider.dispose();
  }
});

test('stale storage responses do not overwrite refreshed node storage data', async () => {
  setupClusterHandlers();
  const staleStorage = deferred();
  let storageCalls = 0;

  FakeProxmoxService.handlers.loadStorage = async () => {
    storageCalls += 1;
    if (storageCalls === 1) {
      return staleStorage.promise;
    }
    return [{ storage: 'new-storage', type: 'dir', used: 1024, total: 4096, avail: 3072 }];
  };
  FakeProxmoxService.handlers.loadSnapshots = async () => [];

  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const connectionItem = rootItems[0];
    const nodeItems = await provider.getChildren(connectionItem);
    const nodeItem = nodeItems[0];

    const staleRequest = provider.getChildren(nodeItem);
    await flushAsyncWork();

    provider.refreshConnection('connection-id');
    const refreshedNodeItems = await provider.getChildren(connectionItem);
    const refreshedNodeItem = refreshedNodeItems[0];
    const freshChildren = await provider.getChildren(refreshedNodeItem);

    assert.equal(storageCalls, 2);
    const freshStorageItem = freshChildren.find((item) => item.id === 'storage:connection-id:node-a:new-storage');
    assert.ok(freshStorageItem, 'Expected refreshed storage item after connection refresh.');

    staleStorage.resolve([{ storage: 'old-storage', type: 'dir', used: 512, total: 2048, avail: 1536 }]);
    const staleChildren = await staleRequest;
    const staleStorageItem = staleChildren.find((item) => item.id === 'storage:connection-id:node-a:new-storage');
    assert.ok(staleStorageItem, 'Expected stale request to resolve using refreshed storage data.');
  } finally {
    provider.dispose();
  }
});

test('sequential expand-refresh-expand stays fresh across connections', async () => {
  const connectionA = {
    id: 'connection-a',
    name: 'Lab A',
    baseUrl: 'https://host-a:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token-a'
  };
  const connectionB = {
    id: 'connection-b',
    name: 'Lab B',
    baseUrl: 'https://host-b:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token-b'
  };

  const staleSnapshotsA = deferred();
  const snapshotCalls = new Map();

  FakeProxmoxService.handlers.loadClusterResources = async (connection) => connection.id === 'connection-a'
    ? [
      { id: 'node-a', type: 'node', node: 'node-a' },
      { id: 'qemu-a', type: 'qemu', node: 'node-a', vmid: 111, name: 'vm-a', status: 'running', cpu: 0.2, maxcpu: 1 }
    ]
    : [
      { id: 'node-b', type: 'node', node: 'node-b' },
      { id: 'qemu-b', type: 'qemu', node: 'node-b', vmid: 222, name: 'vm-b', status: 'running', cpu: 0.4, maxcpu: 2 }
    ];
  FakeProxmoxService.handlers.loadStorage = async () => [];
  FakeProxmoxService.handlers.loadSnapshots = async (connection) => {
    const calls = (snapshotCalls.get(connection.id) ?? 0) + 1;
    snapshotCalls.set(connection.id, calls);
    if (connection.id === 'connection-a') {
      if (calls === 1) {
        return staleSnapshotsA.promise;
      }
      return [{ name: 'snap-a-new', snaptime: 1_700_000_500, vmstate: 0 }];
    }
    return [{ name: 'snap-b', snaptime: 1_700_000_100, vmstate: 0 }];
  };

  const { store } = createConnectionStore({ connections: [connectionA, connectionB] });
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const firstConnection = rootItems.find((item) => item.id === 'connection-a');
    const secondConnection = rootItems.find((item) => item.id === 'connection-b');
    assert.ok(firstConnection, 'Expected connection-a tree item.');
    assert.ok(secondConnection, 'Expected connection-b tree item.');

    const guestB = await getGuestItemForConnection(provider, secondConnection);
    const snapshotsB = await provider.getChildren(guestB);
    assert.equal(snapshotsB[0].label, 'snap-b');
    assert.equal(snapshotCalls.get('connection-b'), 1);

    const guestA = await getGuestItemForConnection(provider, firstConnection);
    const staleRequest = provider.getChildren(guestA);
    await flushAsyncWork();

    provider.refreshConnection('connection-a');
    const freshGuestA = await getGuestItemForConnection(provider, firstConnection);
    const freshSnapshotsA = await provider.getChildren(freshGuestA);
    assert.equal(freshSnapshotsA[0].label, 'snap-a-new');
    assert.equal(snapshotCalls.get('connection-a'), 2);

    staleSnapshotsA.resolve([{ name: 'snap-a-old', snaptime: 1_700_000_000, vmstate: 0 }]);
    const staleResultA = await staleRequest;
    assert.equal(staleResultA.length, 1);
    assert.equal(staleResultA[0].label, 'snap-a-new');

    const snapshotsBAfterARefresh = await provider.getChildren(guestB);
    assert.equal(snapshotsBAfterARefresh[0].label, 'snap-b');
    assert.equal(snapshotCalls.get('connection-b'), 1);
  } finally {
    provider.dispose();
  }
});

test('does not return pending inventory results after disposal', async () => {
  const pending = deferred();
  FakeProxmoxService.handlers.loadClusterResources = async () => pending.promise;
  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const request = provider.getChildren(rootItems[0]);
    await flushAsyncWork();
    provider.dispose();
    pending.resolve([{ id: 'node-a', type: 'node', node: 'node-a' }]);
    assert.deepEqual(await request, []);
    assert.deepEqual(await provider.getChildren(), []);
  } finally {
    provider.dispose();
  }
});

test('sorts node names in natural numeric order', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-10', type: 'node', node: 'node-10' },
    { id: 'node-2', type: 'node', node: 'node-2' }
  ];
  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    assert.deepEqual(nodes.map((item) => item.label), ['node-2', 'node-10']);
  } finally {
    provider.dispose();
  }
});

test('sorts storage names in natural numeric order', async () => {
  setupClusterHandlers();
  FakeProxmoxService.handlers.loadStorage = async () => [
    { storage: 'storage-10', type: 'dir' },
    { storage: 'storage-2', type: 'dir' }
  ];
  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodes[0]);
    assert.deepEqual(children.filter((item) => item.storage).map((item) => item.label), ['storage-2', 'storage-10']);
  } finally {
    provider.dispose();
  }
});

test('sorts equal-time snapshots in natural name order', async () => {
  setupClusterHandlers();
  FakeProxmoxService.handlers.loadSnapshots = async () => [
    { name: 'snapshot-10', snaptime: 1_700_000_000, vmstate: 0 },
    { name: 'snapshot-2', snaptime: 1_700_000_000, vmstate: 0 }
  ];
  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const guest = await getGuestItem(provider);
    const snapshots = await provider.getChildren(guest);
    assert.deepEqual(snapshots.map((item) => item.label), ['snapshot-2', 'snapshot-10']);
  } finally {
    provider.dispose();
  }
});

test('shows an actionable message when there are no connections', async () => {
  const { store } = createConnectionStore({ connections: [] });
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const items = await provider.getChildren();
    assert.equal(items.length, 1);
    assert.equal(items[0].command.command, 'proxmox.addConnection');
  } finally {
    provider.dispose();
  }
});

test('includes running guest counts in node descriptions', async () => {
  FakeProxmoxService.handlers.loadClusterResources = async () => [
    { id: 'node-a', type: 'node', node: 'node-a' },
    { id: 'qemu-1', type: 'qemu', node: 'node-a', vmid: 1, name: 'vm-1', status: 'running' },
    { id: 'qemu-2', type: 'qemu', node: 'node-a', vmid: 2, name: 'vm-2', status: 'stopped' }
  ];
  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    assert.equal(nodes[0].description, '2 guests (1 running)');
  } finally {
    provider.dispose();
  }
});

test('returns no children for a storage or message tree item', async () => {
  setupClusterHandlers();
  FakeProxmoxService.handlers.loadStorage = async () => [{ storage: 'local', type: 'dir' }];
  const { store } = createConnectionStore();
  const provider = new ProxmoxExplorerProvider(store, new Set());
  try {
    const rootItems = await provider.getChildren();
    const nodes = await provider.getChildren(rootItems[0]);
    const children = await provider.getChildren(nodes[0]);
    const storage = children.find((item) => item.storage);
    assert.deepEqual(await provider.getChildren(storage), []);
  } finally {
    provider.dispose();
  }
});
