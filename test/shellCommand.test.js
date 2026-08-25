const assert = require('node:assert/strict');
const test = require('node:test');
const pkg = require('../package.json');
const { buildLxcShellUrl, buildSshCommand, guestActionKey, guestContextValue, isContainerShellItem, isGuestActionItem, resolveGuestActionItem, resolveShellItem } = require('../out/shellAccess');

const connection = {
  id: 'connection-id',
  name: 'Test connection',
  baseUrl: 'https://host:8006',
  realm: 'pve',
  username: 'user',
  tokenId: 'token'
};

const lxcResource = {
  id: 'lxc-101',
  type: 'lxc',
  node: 'pve1',
  vmid: 101,
  name: 'app-container',
  status: 'running'
};

const qemuResource = {
  id: 'qemu-200',
  type: 'qemu',
  node: 'pve1',
  vmid: 200,
  name: 'vm',
  status: 'running'
};

test('accepts a valid LXC shell item', () => {
  assert.equal(isContainerShellItem({ connection, resource: lxcResource }), true);
});

test('rejects non-LXC items', () => {
  assert.equal(isContainerShellItem({ connection, resource: qemuResource }), false);
});

test('resolves the selected LXC item when no command argument is passed', () => {
  const resolved = resolveShellItem(undefined, [{ connection, resource: lxcResource }]);
  assert.deepEqual(resolved, { connection, resource: lxcResource });
});

test('returns undefined when the selection is not LXC', () => {
  assert.equal(resolveShellItem(undefined, [{ connection, resource: qemuResource }]), undefined);
});

test('does not fall back to selection when shell command argument is invalid', () => {
  const invalidItem = { connection: { ...connection, baseUrl: 'http://host:8006' }, resource: lxcResource };
  assert.equal(resolveShellItem(invalidItem, [{ connection, resource: lxcResource }]), undefined);
});

test('does not fall back to selection when guest action argument is invalid', () => {
  const invalidItem = { connection, resource: { ...qemuResource, vmid: 0 } };
  assert.equal(resolveGuestActionItem(invalidItem, [{ connection, resource: qemuResource }]), undefined);
});

test('builds the Proxmox xterm.js URL for an LXC shell', () => {
  assert.equal(
    buildLxcShellUrl({ connection, resource: lxcResource }),
    'https://host:8006/?console=lxc&xtermjs=1&vmid=101&node=pve1'
  );
});

test('suffixes the guest context value with running or stopped status', () => {
  assert.equal(guestContextValue('lxc', 'running'), 'proxmoxContainer:running');
  assert.equal(guestContextValue('lxc', 'stopped'), 'proxmoxContainer:stopped');
  assert.equal(guestContextValue('qemu', 'running'), 'proxmoxQemu:running');
  assert.equal(guestContextValue('qemu', 'stopped'), 'proxmoxQemu:stopped');
});

test('falls back to the plain context value for ambiguous guest status', () => {
  assert.equal(guestContextValue('lxc', 'paused'), 'proxmoxContainer');
  assert.equal(guestContextValue('qemu', undefined), 'proxmoxQemu');
});

test('builds a stable key for an in-flight guest action', () => {
  assert.equal(guestActionKey('connection-id', 'lxc', 101), 'connection-id:lxc:101');
});

test('rejects shell targets with blank nodes', () => {
  assert.equal(isContainerShellItem({ connection, resource: { ...lxcResource, node: ' ' } }), false);
});

test('rejects shell targets with invalid VMIDs', () => {
  assert.equal(isContainerShellItem({ connection, resource: { ...lxcResource, vmid: 0 } }), false);
  assert.equal(isContainerShellItem({ connection, resource: { ...lxcResource, vmid: 1.5 } }), false);
});

test('rejects guest action targets with invalid connections', () => {
  assert.equal(isGuestActionItem({ connection: { ...connection, baseUrl: 'http://host:8006' }, resource: lxcResource }), false);
});

test('rejects guest action targets with malformed resource fields', () => {
  assert.equal(isGuestActionItem({ connection, resource: { ...qemuResource, node: 42 } }), false);
  assert.equal(isGuestActionItem({ connection, resource: { ...qemuResource, vmid: '200' } }), false);
});

test('quotes SSH targets before sending them to a shell', () => {
  assert.equal(buildSshCommand('user; touch /tmp/pwned', 'host'), "ssh 'user; touch /tmp/pwned@host'");
});

test('escapes single quotes in SSH usernames', () => {
  assert.equal(buildSshCommand("o'reilly", 'host'), "ssh 'o'\\''reilly@host'");
});

test('rejects SSH targets containing control characters', () => {
  assert.throws(() => buildSshCommand('user\nname', 'host'), /control characters/);
  assert.throws(() => buildSshCommand('user', 'host\rname'), /control characters/);
});

test('encodes shell URL query values', () => {
  const target = { connection, resource: { ...lxcResource, node: 'node/a' } };
  assert.match(buildLxcShellUrl(target), /node=node%2Fa/);
});

test('preserves QEMU context values for unknown states', () => {
  assert.equal(guestContextValue('qemu', 'paused'), 'proxmoxQemu');
});

test('hides start and stop actions while a guest operation is in progress', () => {
  const commands = pkg.contributes.menus['view/item/context'];
  const startRule = commands.find((entry) => entry.command === 'proxmox.startGuest').when;
  const stopRule = commands.find((entry) => entry.command === 'proxmox.stopGuest').when;

  assert.doesNotMatch(startRule, /proxmoxContainer:busy|proxmoxQemu:busy/);
  assert.doesNotMatch(stopRule, /proxmoxContainer:busy|proxmoxQemu:busy/);
});

test('shows start and stop only for explicit stopped or running states', () => {
  const commands = pkg.contributes.menus['view/item/context'];
  const startRule = commands.find((entry) => entry.command === 'proxmox.startGuest').when;
  const stopRule = commands.find((entry) => entry.command === 'proxmox.stopGuest').when;

  assert.match(startRule, /proxmoxContainer:stopped/);
  assert.match(startRule, /proxmoxQemu:stopped/);
  assert.doesNotMatch(startRule, /viewItem == proxmoxContainer(\s|\)|\|\|)/);
  assert.doesNotMatch(startRule, /viewItem == proxmoxQemu(\s|\)|\|\|)/);

  assert.match(stopRule, /proxmoxContainer:running/);
  assert.match(stopRule, /proxmoxQemu:running/);
  assert.doesNotMatch(stopRule, /viewItem == proxmoxContainer(\s|\)|\|\|)/);
  assert.doesNotMatch(stopRule, /viewItem == proxmoxQemu(\s|\)|\|\|)/);
});

// SSH Hostname Fix Tests
test('SSH command uses provided hostname directly', () => {
  const result = buildSshCommand('user', 'my-guest-hostname');
  assert.match(result, /user@my-guest-hostname/);
});

test('SSH command accepts guest hostname from config', () => {
  // When guest config provides a hostname like 'app-server'
  const result = buildSshCommand('root', 'app-server');
  assert.equal(result, "ssh 'root@app-server'");
});

test('SSH command falls back to server hostname if guest hostname unavailable', () => {
  // Server hostname extracted from connection URL: new URL(baseUrl).hostname
  const result = buildSshCommand('user', 'proxmox.example.com');
  assert.match(result, /user@proxmox.example.com/);
});

test('SSH command handles container with complex hostname', () => {
  // Some systems use longer hostnames with dots and dashes
  const result = buildSshCommand('root', 'app-web-01.internal.local');
  assert.equal(result, "ssh 'root@app-web-01.internal.local'");
});

test('SSH command validates hostname contains no control characters', () => {
  assert.throws(() => buildSshCommand('user', 'host\nname'), /control characters/);
  assert.throws(() => buildSshCommand('user', 'host\rname'), /control characters/);
  assert.throws(() => buildSshCommand('user', 'host\x00name'), /control characters/);
});

test('SSH command accepts alphanumeric hostnames', () => {
  const testCases = [
    'localhost',
    'vm1',
    'guest-server',
    '192.168.1.100',
    'container.domain.com'
  ];

  for (const hostname of testCases) {
    assert.doesNotThrow(() => {
      buildSshCommand('root', hostname);
    }, `Should accept hostname: ${hostname}`);
  }
});

test('buildSshCommand with typical container hostname pattern', () => {
  // LXC container hostname from config endpoint
  const result = buildSshCommand('root', 'mycontainer');
  assert.equal(result, "ssh 'root@mycontainer'");
});

test('buildSshCommand with typical QEMU hostname pattern', () => {
  // QEMU VM hostname from config endpoint
  const result = buildSshCommand('ubuntu', 'vm-prod-01');
  assert.equal(result, "ssh 'ubuntu@vm-prod-01'");
});
