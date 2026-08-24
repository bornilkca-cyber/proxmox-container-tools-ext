const assert = require('node:assert/strict');
const test = require('node:test');
const { ConnectionStore } = require('../out/connectionStore');

function connection() {
  return {
    id: 'connection-id',
    name: 'Test connection',
    baseUrl: 'https://host:8006',
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };
}

const canonicalFingerprint = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const compactFingerprint = canonicalFingerprint.replaceAll(':', '');

function createContext({
  connections = [],
  secrets = {},
  failGlobalUpdate = false,
  failGlobalUpdateOnCall,
  failSecretDelete = false
} = {}) {
  const secretValues = new Map(Object.entries(secrets));
  let storedConnections = connections;
  let globalUpdateCalls = 0;

  return {
    globalState: {
      get: (_key, fallback) => storedConnections ?? fallback,
      update: async (_key, value) => {
        globalUpdateCalls += 1;
        if (failGlobalUpdate || globalUpdateCalls === failGlobalUpdateOnCall) {
          throw new Error('global state unavailable');
        }
        storedConnections = value;
      }
    },
    secrets: {
      get: async (key) => secretValues.get(key),
      store: async (key, value) => secretValues.set(key, value),
      delete: async (key) => {
        if (failSecretDelete) {
          throw new Error('secret deletion unavailable');
        }
        secretValues.delete(key);
      }
    },
    secretValues,
    getConnections: () => storedConnections
  };
}

[
  ['lowercase compact fingerprint', compactFingerprint.toLowerCase()],
  ['uppercase compact fingerprint', compactFingerprint],
  ['lowercase colon fingerprint', canonicalFingerprint.toLowerCase()],
  ['surrounding whitespace fingerprint', ` ${compactFingerprint.toLowerCase()} `]
].forEach(([label, certificateFingerprint]) => {
  test(`canonicalizes ${label} when saving a connection`, async () => {
    const context = createContext();
    const store = new ConnectionStore(context);

    await store.save({ ...connection(), certificateFingerprint }, { tokenSecret: 'secret' });

    assert.deepEqual(store.getConnections(), [{ ...connection(), certificateFingerprint: canonicalFingerprint }]);
  });
});

[
  ['compact fingerprint', compactFingerprint.toLowerCase()],
  ['colon fingerprint', canonicalFingerprint.toLowerCase()],
  ['trimmed fingerprint', `\t${compactFingerprint}\n`]
].forEach(([label, certificateFingerprint]) => {
  test(`canonicalizes ${label} when updating a connection`, async () => {
    const original = connection();
    const context = createContext({ connections: [original] });
    const store = new ConnectionStore(context);

    await store.update({ ...original, certificateFingerprint });

    assert.deepEqual(store.getConnections(), [{ ...original, certificateFingerprint: canonicalFingerprint }]);
  });
});

[
  ['short fingerprint', 'AA:BB'],
  ['too-long fingerprint', `${compactFingerprint}AA`],
  ['non-hex fingerprint', 'GG'.repeat(32)],
  ['mixed-delimiter fingerprint', 'AA:BBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899'],
  ['embedded-whitespace fingerprint', `${compactFingerprint.slice(0, 32)} ${compactFingerprint.slice(32)}`]
].forEach(([label, certificateFingerprint]) => {
  test(`ignores persisted connection with ${label}`, () => {
    const validConnection = connection();
    const context = createContext({
      connections: [
        validConnection,
        { ...validConnection, id: label.replaceAll(' ', '-'), certificateFingerprint }
      ]
    });
    const store = new ConnectionStore(context);

    assert.deepEqual(store.getConnections(), [validConnection]);
  });
});

[
  ['name', '  Trimmed connection  ', 'Trimmed connection'],
  ['realm', '  pve  ', 'pve'],
  ['username', '  user  ', 'user'],
  ['tokenId', '  token  ', 'token']
].forEach(([field, value, expected]) => {
  test(`trims ${field} when saving a connection`, async () => {
    const context = createContext();
    const store = new ConnectionStore(context);

    await store.save({ ...connection(), [field]: value }, { tokenSecret: 'secret' });

    assert.equal(store.getConnections()[0][field], expected);
  });
});

test('trims token secrets before storing them', async () => {
  const context = createContext();
  const store = new ConnectionStore(context);

  await store.save(connection(), { tokenSecret: '  secret  ' });

  assert.equal(context.secretValues.get('proxmox.token.connection-id'), 'secret');
});

test('trims token secrets returned from secret storage', async () => {
  const context = createContext({ secrets: { 'proxmox.token.connection-id': '  secret  ' } });
  const store = new ConnectionStore(context);

  assert.deepEqual(await store.getCredentials(connection()), { tokenSecret: 'secret' });
});

test('restores the existing token secret when metadata update fails', async () => {
  const existingConnection = connection();
  const context = createContext({
    connections: [existingConnection],
    secrets: { 'proxmox.token.connection-id': 'previous-secret' },
    failGlobalUpdate: true
  });
  const store = new ConnectionStore(context);

  await assert.rejects(
    () => store.save({ ...existingConnection, name: 'Updated connection' }, { tokenSecret: 'replacement-secret' }),
    /global state unavailable/
  );

  assert.equal(context.secretValues.get('proxmox.token.connection-id'), 'previous-secret');
  assert.deepEqual(context.getConnections(), [existingConnection]);
});

test('restores connection metadata when secret deletion fails', async () => {
  const existingConnection = connection();
  const context = createContext({
    connections: [existingConnection],
    secrets: { 'proxmox.token.connection-id': 'existing-secret' },
    failSecretDelete: true
  });
  const store = new ConnectionStore(context);

  await assert.rejects(() => store.remove(existingConnection), /secret deletion unavailable/);

  assert.deepEqual(context.getConnections(), [existingConnection]);
  assert.equal(context.secretValues.get('proxmox.token.connection-id'), 'existing-secret');
});

test('preserves the secret deletion error when metadata rollback fails', async () => {
  const existingConnection = connection();
  const context = createContext({
    connections: [existingConnection],
    secrets: { 'proxmox.token.connection-id': 'existing-secret' },
    failGlobalUpdateOnCall: 2,
    failSecretDelete: true
  });
  const store = new ConnectionStore(context);

  await assert.rejects(() => store.remove(existingConnection), /secret deletion unavailable/);
});

test('ignores malformed persisted connections', () => {
  const validConnection = connection();
  const context = createContext({
    connections: [validConnection, { id: 'invalid', name: 'Incomplete connection' }]
  });
  const store = new ConnectionStore(context);

  assert.deepEqual(store.getConnections(), [validConnection]);
});

test('ignores persisted connections with whitespace-only fields', () => {
  const validConnection = connection();
  const context = createContext({
    connections: [
      validConnection,
      { ...validConnection, id: 'blank-name', name: '   ' },
      { ...validConnection, id: 'blank-realm', realm: '\t' }
    ]
  });
  const store = new ConnectionStore(context);

  assert.deepEqual(store.getConnections(), [validConnection]);
});

test('ignores persisted connections with blank certificate fingerprints', () => {
  const validConnection = connection();
  const context = createContext({
    connections: [
      validConnection,
      { ...validConnection, id: 'empty-fingerprint', certificateFingerprint: '' },
      { ...validConnection, id: 'blank-fingerprint', certificateFingerprint: '   ' }
    ]
  });
  const store = new ConnectionStore(context);

  assert.deepEqual(store.getConnections(), [validConnection]);
});

test('normalizes persisted compact certificate fingerprints', () => {
  const compactFingerprint = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
  const context = createContext({
    connections: [{ ...connection(), certificateFingerprint: compactFingerprint }]
  });
  const store = new ConnectionStore(context);

  assert.deepEqual(store.getConnections(), [{
    ...connection(),
    certificateFingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
  }]);
});

test('rejects mixed-delimiter certificate fingerprints', () => {
  const validConnection = connection();
  const context = createContext({
    connections: [
      validConnection,
      { ...validConnection, id: 'mixed-fingerprint', certificateFingerprint: 'AA:BBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899' }
    ]
  });
  const store = new ConnectionStore(context);

  assert.deepEqual(store.getConnections(), [validConnection]);
});

test('deduplicates persisted connections by ID', () => {
  const first = connection();
  const second = { ...first, name: 'Updated connection' };
  const context = createContext({ connections: [first, second] });
  const store = new ConnectionStore(context);

  assert.deepEqual(store.getConnections(), [second]);
});

test('rejects invalid connections before writing metadata or secrets', async () => {
  const context = createContext();
  const store = new ConnectionStore(context);

  await assert.rejects(
    () => store.save({ ...connection(), baseUrl: 'http://host:8006' }, { tokenSecret: 'secret' }),
    /Invalid Proxmox connection/
  );
  assert.deepEqual(context.getConnections(), []);
  assert.equal(context.secretValues.size, 0);
});

test('rejects blank token secrets before writing metadata or secrets', async () => {
  const context = createContext();
  const store = new ConnectionStore(context);

  await assert.rejects(
    () => store.save(connection(), { tokenSecret: '  ' }),
    /token secret is missing/
  );
  assert.deepEqual(context.getConnections(), []);
  assert.equal(context.secretValues.size, 0);
});

test('serializes concurrent saves for the same connection', async () => {
  const context = createContext();
  const store = new ConnectionStore(context);
  await Promise.all([
    store.save(connection(), { tokenSecret: 'first' }),
    store.save({ ...connection(), name: 'Second' }, { tokenSecret: 'second' })
  ]);

  assert.deepEqual(store.getConnections(), [{ ...connection(), name: 'Second' }]);
  assert.equal(context.secretValues.get('proxmox.token.connection-id'), 'second');
});

test('returns undefined when a connection has no stored secret', async () => {
  const context = createContext();
  const store = new ConnectionStore(context);

  assert.equal(await store.getCredentials(connection()), undefined);
});

test('updates connection metadata without changing the stored secret', async () => {
  const original = connection();
  const context = createContext({
    connections: [original],
    secrets: { 'proxmox.token.connection-id': 'existing-secret' }
  });
  const store = new ConnectionStore(context);

  await store.update({ ...original, name: 'Renamed connection' });

  assert.deepEqual(store.getConnections(), [{ ...original, name: 'Renamed connection' }]);
  assert.equal(context.secretValues.get('proxmox.token.connection-id'), 'existing-secret');
});

test('canonicalizes certificate fingerprints when saving metadata', async () => {
  const context = createContext();
  const store = new ConnectionStore(context);

  await store.save({
    ...connection(),
    certificateFingerprint: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
  }, { tokenSecret: 'secret' });

  assert.deepEqual(store.getConnections(), [{
    ...connection(),
    certificateFingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
  }]);
});

test('rejects invalid connections in update before writing metadata', async () => {
  const original = connection();
  const context = createContext({ connections: [original] });
  const store = new ConnectionStore(context);

  await assert.rejects(
    () => store.update({ ...original, baseUrl: 'http://host:8006' }),
    /Invalid Proxmox connection/
  );
  assert.deepEqual(store.getConnections(), [original]);
});
