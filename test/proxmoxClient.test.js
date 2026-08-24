const assert = require('node:assert/strict');
const test = require('node:test');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { readCertificateFingerprint } = require('../out/certificateTrust');
const { ProxmoxApiError, ProxmoxClient, parsePinnedResponse } = require('../out/proxmoxClient');
const { isProxmoxConnection } = require('../out/proxmoxTypes');

function connection(baseUrl = 'https://host:8006') {
  return {
    id: 'connection-id',
    name: 'Test connection',
    baseUrl,
    realm: 'pve',
    username: 'user',
    tokenId: 'token'
  };
}

const canonicalFingerprint = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const compactFingerprint = canonicalFingerprint.replaceAll(':', '');

async function withMockCertificateResponse(certificate, callback) {
  const originalGet = https.get;
  const requestedUrls = [];
  const requestedOptions = [];
  https.get = (url, options, responseCallback) => {
    requestedUrls.push(url.toString());
    requestedOptions.push(options);
    const response = {
      socket: { getPeerCertificate: () => certificate },
      on: () => undefined,
      resume: () => undefined
    };
    responseCallback(response);
    return {
      setTimeout: () => undefined,
      on: () => undefined
    };
  };

  try {
    return await callback({ requestedUrls, requestedOptions });
  } finally {
    https.get = originalGet;
  }
}

[
  ['server root URL', 'https://host:8006', 'https://host:8006/api2/json/version'],
  ['server root URL with trailing slash', 'https://host:8006/', 'https://host:8006/api2/json/version'],
  ['API URL', 'https://host:8006/api2/json', 'https://host:8006/api2/json/version'],
  ['API URL with trailing slash', 'https://host:8006/api2/json/', 'https://host:8006/api2/json/version']
].forEach(([label, baseUrl, expectedUrl]) => {
  test(`discovers certificate from ${label}`, async () => {
    await withMockCertificateResponse({ fingerprint256: canonicalFingerprint }, async ({ requestedUrls, requestedOptions }) => {
      assert.equal(await readCertificateFingerprint(baseUrl), canonicalFingerprint);
      assert.deepEqual(requestedUrls, [expectedUrl]);
      assert.deepEqual(requestedOptions, [{ agent: false, rejectUnauthorized: false }]);
    });
  });
});

[
  ['short fingerprint', 'AA:BB'],
  ['blank fingerprint', ' '],
  ['non-hex fingerprint', 'GG'.repeat(32)],
  ['too-long fingerprint', 'AA'.repeat(33)],
  ['too-short compact fingerprint', 'AA'.repeat(31)],
  ['non-string fingerprint', 123]
].forEach(([label, fingerprint256]) => {
  test(`rejects discovered certificate with ${label}`, async () => {
    await withMockCertificateResponse({ fingerprint256 }, async () => {
      await assert.rejects(
        () => readCertificateFingerprint('https://host:8006'),
        /valid certificate fingerprint/
      );
    });
  });
});

[
  ['uppercase compact fingerprint', compactFingerprint],
  ['lowercase compact fingerprint', compactFingerprint.toLowerCase()],
  ['lowercase colon fingerprint', canonicalFingerprint.toLowerCase()],
  ['whitespace-delimited fingerprint', compactFingerprint.match(/../g).join('\n\t')]
].forEach(([label, fingerprint256]) => {
  test(`normalizes discovered ${label}`, async () => {
    await withMockCertificateResponse({ fingerprint256 }, async () => {
      assert.equal(await readCertificateFingerprint('https://host:8006'), canonicalFingerprint);
    });
  });
});

[
  ['canonical fingerprint', canonicalFingerprint, true],
  ['compact fingerprint', compactFingerprint, true],
  ['lowercase compact fingerprint', compactFingerprint.toLowerCase(), true],
  ['lowercase colon fingerprint', canonicalFingerprint.toLowerCase(), true],
  ['blank fingerprint', ' ', false],
  ['short fingerprint', 'AA:BB', false],
  ['mixed delimiter fingerprint', 'AA:BBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899', false],
  ['whitespace compact fingerprint', compactFingerprint.slice(0, 32) + ' ' + compactFingerprint.slice(32), false]
].forEach(([label, certificateFingerprint, expected]) => {
  test(`validates persisted ${label}`, () => {
    assert.equal(isProxmoxConnection({ ...connection(), certificateFingerprint }), expected);
  });
});

test('discovers the certificate from the correct API version URL', async () => {
  const originalGet = https.get;
  const requestedUrls = [];
  https.get = (url, _options, callback) => {
    requestedUrls.push(url.toString());
    const response = {
      socket: { getPeerCertificate: () => ({ fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99' }) },
      on: () => undefined,
      resume: () => undefined
    };
    callback(response);
    return {
      setTimeout: () => undefined,
      on: () => undefined
    };
  };

  try {
    await readCertificateFingerprint('https://host:8006/api2/json');
    assert.deepEqual(requestedUrls, ['https://host:8006/api2/json/version']);
  } finally {
    https.get = originalGet;
  }
});

test('rejects certificate response stream errors', async () => {
  const originalGet = https.get;
  https.get = (_url, _options, callback) => {
    let responseError;
    const response = {
      socket: { getPeerCertificate: () => ({ fingerprint256: 'AA:BB' }) },
      on: (event, handler) => {
        if (event === 'error') {
          responseError = handler;
        }
      },
      resume: () => responseError(new Error('certificate response failed'))
    };
    callback(response);
    return {
      setTimeout: () => undefined,
      on: () => undefined
    };
  };

  try {
    await assert.rejects(
      () => readCertificateFingerprint('https://host:8006'),
      /certificate response failed/
    );
  } finally {
    https.get = originalGet;
  }
});

test('normalizes discovered certificate fingerprints before storing trust', async () => {
  const originalGet = https.get;
  https.get = (_url, _options, callback) => {
    const response = {
      socket: { getPeerCertificate: () => ({ fingerprint256: 'aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99' }) },
      on: () => undefined,
      resume: () => undefined
    };
    callback(response);
    return {
      setTimeout: () => undefined,
      on: () => undefined
    };
  };

  try {
    assert.equal(
      await readCertificateFingerprint('https://host:8006'),
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
    );
  } finally {
    https.get = originalGet;
  }
});

test('rejects invalid discovered certificate fingerprints', async () => {
  const originalGet = https.get;
  https.get = (_url, _options, callback) => {
    const response = {
      socket: { getPeerCertificate: () => ({ fingerprint256: 'AA:BB' }) },
      on: () => undefined,
      resume: () => undefined
    };
    callback(response);
    return {
      setTimeout: () => undefined,
      on: () => undefined
    };
  };

  try {
    await assert.rejects(
      () => readCertificateFingerprint('https://host:8006'),
      /valid certificate fingerprint/
    );
  } finally {
    https.get = originalGet;
  }
});

test('uses the Proxmox JSON API path and GET for inventory', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
  };

  try {
    await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources();
    assert.deepEqual(requests, [{
      url: 'https://host:8006/api2/json/cluster/resources',
      method: 'GET'
    }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('loads and validates guest snapshots', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ name: 'before-upgrade', description: null, parent: null, snaptime: 1700000000, vmstate: 0 }] })
    };
  };

  try {
    const snapshots = await new ProxmoxClient(connection(), { tokenSecret: 'secret' })
      .getSnapshots('lxc', 'node-a', 101);
    assert.deepEqual(snapshots, [{ name: 'before-upgrade', description: null, parent: null, snaptime: 1700000000, vmstate: 0 }]);
    assert.deepEqual(requests, [{
      url: 'https://host:8006/api2/json/nodes/node-a/lxc/101/snapshot',
      method: 'GET'
    }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects snapshots with an invalid creation timestamp', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ name: 'invalid-snapshot', snaptime: 0 }] })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getSnapshots('lxc', 'node-a', 101),
      /snapshot list/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects non-HTTPS persisted connections', () => {
  assert.throws(
    () => new ProxmoxClient(connection('http://host:8006'), { tokenSecret: 'secret' }),
    (error) => error instanceof ProxmoxApiError && error.message.includes('HTTPS')
  );
});

test('rejects connection URLs with credentials or query components', () => {
  assert.throws(
    () => new ProxmoxClient(connection('https://user:secret@host:8006'), { tokenSecret: 'secret' }),
    (error) => error instanceof ProxmoxApiError && error.message.includes('must not contain credentials')
  );
  assert.throws(
    () => new ProxmoxClient(connection('https://host:8006?debug=true'), { tokenSecret: 'secret' }),
    (error) => error instanceof ProxmoxApiError && error.message.includes('must not contain credentials')
  );
  assert.throws(
    () => new ProxmoxClient(connection('https://host:8006#section'), { tokenSecret: 'secret' }),
    (error) => error instanceof ProxmoxApiError && error.message.includes('must not contain credentials')
  );
});

test('accepts connection URLs ending with /api2/json/', () => {
  assert.doesNotThrow(() => new ProxmoxClient(connection('https://host:8006/api2/json/'), { tokenSecret: 'secret' }));
});

test('rejects connection URLs with unsupported paths', () => {
  assert.throws(
    () => new ProxmoxClient(connection('https://host:8006/proxmox'), { tokenSecret: 'secret' }),
    (error) => error instanceof ProxmoxApiError && error.message.includes('server root')
  );
});

test('rejects malformed persisted connection URLs', () => {
  assert.throws(
    () => new ProxmoxClient(connection('not-a-url'), { tokenSecret: 'secret' }),
    (error) => error instanceof ProxmoxApiError && error.message.includes('URL is invalid')
  );
});

test('rejects empty token secrets', () => {
  assert.throws(
    () => new ProxmoxClient(connection(), { tokenSecret: ' ' }),
    (error) => error instanceof ProxmoxApiError && error.message.includes('token secret')
  );
});

test('redacts the token from API error details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ errors: { message: 'invalid secret' } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'invalid secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && !error.message.includes('invalid secret')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('handles malformed API error payloads', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Server Error',
    json: async () => ({ errors: 'unexpected error shape' })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }, 10).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && error.message.includes('API error')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('preserves HTTP errors with non-JSON bodies', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => { throw new SyntaxError('invalid JSON'); }
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && error.status === 401 && error.message.includes('Unauthorized')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('reports untrusted Proxmox certificates clearly', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' };
    throw error;
  };

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && error.message.includes('certificate is not trusted')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('reports untrusted certificates when TLS code is exposed on error.code', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error('self signed certificate');
    error.code = 'SELF_SIGNED_CERT_IN_CHAIN';
    throw error;
  };

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && error.message.includes('certificate is not trusted')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizes cancellation failures to a Proxmox API error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => await new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('transport aborted')), { once: true });
  });
  const controller = new AbortController();

  try {
    const request = new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(controller.signal);
    controller.abort();
    await assert.rejects(request, (error) => error instanceof ProxmoxApiError && error.message.includes('cancelled'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects malformed API response bodies', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => null
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects primitive API response bodies', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => 1
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects non-array resource data', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { resource: 'invalid' } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && error.message.includes('resource list')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects malformed resource entries', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ type: 'lxc' }] })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && error.message.includes('resource list')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects resource entries with blank identifiers', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ id: '  ', type: 'node' }, { id: 'node-a', type: '  ' }] })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      /resource list/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('drops storage entries with blank names and defaults blank types', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ storage: ' ', type: 'dir' }, { storage: 'local', type: ' ' }] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [{ storage: 'local', type: 'unknown', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects snapshots with an invalid memory-state flag', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ name: 'snapshot-a', vmstate: 2 }] })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getSnapshots('qemu', 'node-a', 101),
      /snapshot list/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects API envelopes with a non-object errors field', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [], errors: null })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      /API error/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects malformed inventory fields but tolerates malformed storage numeric fields', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      data: url.includes('/storage')
        ? [{ storage: 'local', type: 'dir', used: Number.NaN }]
        : [{ id: 'lxc-101', type: 'lxc', mem: -1 }]
    })
  });

  try {
    const client = new ProxmoxClient(connection(), { tokenSecret: 'secret' });
    await assert.rejects(() => client.getClusterResources(), /resource list/);
    assert.deepEqual(
      await client.getStorage('node-a'),
      [{ storage: 'local', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects non-positive or fractional VM IDs', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ id: 'qemu-1', type: 'qemu', vmid: 1.5 }, { id: 'qemu-0', type: 'qemu', vmid: 0 }] })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      /resource list/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects blank node arguments before making a request', async () => {
  const originalFetch = global.fetch;
  let requestStarted = false;
  global.fetch = async () => {
    requestStarted = true;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
  };

  try {
    assert.throws(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage(' '),
      /node name/
    );
    assert.equal(requestStarted, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps valid storage entries when some storage entries are malformed', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      data: [
        { storage: 'local', type: 'dir', used: Number.NaN },
        { storage: 'ceph', type: 'rbd', used: 1024, total: 4096, avail: 3072 }
      ]
    })
  });

  try {
    const storage = await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a');
    assert.deepEqual(storage, [
      { storage: 'local', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined },
      { storage: 'ceph', type: 'rbd', content: undefined, used: 1024, avail: 3072, total: 4096, active: undefined }
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('returns an empty storage list when all storage entries have blank names', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ storage: ' ', type: 'dir' }, { storage: '\t', type: 'nfs' }] })
  });

  try {
    assert.deepEqual(await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'), []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('trims storage names and types before returning storage entries', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ storage: ' local ', type: ' dir ' }] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [{ storage: 'local', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('treats blank storage numeric strings as missing values', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ storage: 'local', type: 'dir', used: ' ', avail: '', total: '\t', active: ' ' }] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [{ storage: 'local', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('drops invalid storage numeric values per field without dropping the storage', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ storage: 'local', type: 'dir', used: -1, avail: 'NaN', total: Infinity, active: {} }] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [{ storage: 'local', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizes boolean storage active flags', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [
      { storage: 'enabled', type: 'dir', active: true },
      { storage: 'disabled', type: 'dir', active: false }
    ] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [
        { storage: 'enabled', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: 1 },
        { storage: 'disabled', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: 0 }
      ]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps only valid storage active flag numbers', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [
      { storage: 'active', type: 'dir', active: 1 },
      { storage: 'inactive', type: 'dir', active: 0 },
      { storage: 'invalid', type: 'dir', active: 2 }
    ] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [
        { storage: 'active', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: 1 },
        { storage: 'inactive', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: 0 },
        { storage: 'invalid', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }
      ]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps only valid storage active flag strings', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [
      { storage: 'active', type: 'dir', active: '1' },
      { storage: 'inactive', type: 'dir', active: '0' },
      { storage: 'invalid', type: 'dir', active: 'true' }
    ] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [
        { storage: 'active', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: 1 },
        { storage: 'inactive', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: 0 },
        { storage: 'invalid', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }
      ]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('parses storage numeric strings without showing storage load failures', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ storage: 'local', type: 'dir', used: '1', avail: '2', total: '3' }] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [{ storage: 'local', type: 'dir', content: undefined, used: 1, avail: 2, total: 3, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('deduplicates duplicate storage names using the latest entry', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [
      { storage: 'local', type: 'dir', used: 1 },
      { storage: 'local', type: 'zfspool', used: 2 }
    ] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [{ storage: 'local', type: 'zfspool', content: undefined, used: 2, avail: undefined, total: undefined, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizes array storage content to a display string', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ storage: 'local', type: 'dir', content: ['images', ' iso ', 'images', 7, ''] }] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [{ storage: 'local', type: 'dir', content: 'images, iso', used: undefined, avail: undefined, total: undefined, active: undefined }]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('trims string storage content and hides blank content', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [
      { storage: 'local', type: 'dir', content: ' images,iso ' },
      { storage: 'empty', type: 'dir', content: ' ' }
    ] })
  });

  try {
    assert.deepEqual(
      await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'),
      [
        { storage: 'local', type: 'dir', content: 'images,iso', used: undefined, avail: undefined, total: undefined, active: undefined },
        { storage: 'empty', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }
      ]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('accepts storage entries with nullable optional numeric fields', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      data: [{ storage: 'local', type: 'dir', used: null, total: null, avail: null, active: null }]
    })
  });

  try {
    const storage = await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a');
    assert.deepEqual(storage, [{ storage: 'local', type: 'dir', content: undefined, used: undefined, avail: undefined, total: undefined, active: undefined }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects cluster resources with invalid CPU ratios', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [
      { id: 'qemu-101', type: 'qemu', cpu: 1.5 },
      { id: 'qemu-102', type: 'qemu', cpu: -0.1 }
    ] })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      /resource list/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('accepts cluster resources with CPU ratios from zero to one', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [
      { id: 'qemu-100', type: 'qemu', cpu: 0 },
      { id: 'qemu-101', type: 'qemu', cpu: 1 }
    ] })
  });

  try {
    assert.equal(
      (await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources()).length,
      2
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects cluster resources with malformed optional strings', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [
    { id: 'node-a', type: 'node', node: 123 },
    { id: 'qemu-1', type: 'qemu', name: { value: 'vm' } },
    { id: 'qemu-2', type: 'qemu', status: 1 }
  ] }) });
  try {
    await assert.rejects(() => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(), /resource list/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects invalid snapshot and guest-action arguments before fetching', async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
  };
  try {
    const client = new ProxmoxClient(connection(), { tokenSecret: 'secret' });
    assert.throws(() => client.getSnapshots('lxc', ' ', 1), /node name/);
    assert.throws(() => client.getSnapshots('lxc', 'node-a', 0), /VMID/);
    assert.throws(() => client.startGuest('lxc', 'node-a', 1.2), /VMID/);
    assert.throws(() => client.stopGuest('lxc', 'node-a', -1), /VMID/);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('trims node names before requesting storage and snapshots', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [] })
    };
  };

  try {
    const client = new ProxmoxClient(connection(), { tokenSecret: 'secret' });
    await client.getStorage(' node-a ');
    await client.getSnapshots('lxc', ' node-a ', 101);
    assert.equal(urls[0], 'https://host:8006/api2/json/nodes/node-a/storage');
    assert.equal(urls[1], 'https://host:8006/api2/json/nodes/node-a/lxc/101/snapshot');
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects malformed persisted certificate fingerprints', () => {
  assert.equal(isProxmoxConnection({ ...connection(), certificateFingerprint: 'not-a-fingerprint' }), false);
  assert.equal(isProxmoxConnection({ ...connection(), certificateFingerprint: 'AA:BB' }), false);
});

test('rejects client URLs with surrounding whitespace', () => {
  assert.throws(
    () => new ProxmoxClient({ ...connection(), baseUrl: ' https://host:8006 ' }, { tokenSecret: 'secret' }),
    /surrounding whitespace/
  );
});

test('aborts an in-flight task request at the task deadline', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => await new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('deadline abort')), { once: true });
  });
  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('node-a', 'UPID:test', undefined, 10),
      /task polling timed out/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects oversized streamed API responses', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(10 * 1024 * 1024 + 1)));
        controller.close();
      }
    })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      /exceeded the maximum supported size/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

function withSelfSignedServer(handler, callback) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pve-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes', '-subj', '/CN=localhost'
    ]);
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const fingerprint256 = new X509Certificate(cert).fingerprint256;
    const server = https.createServer({ key, cert }, handler);
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        callback(`https://127.0.0.1:${port}`, fingerprint256)
          .then(resolve, reject)
          .finally(() => server.close());
      });
      server.on('error', reject);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('completes requests over a pinned certificate instead of hanging', async () => {
  await withSelfSignedServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    },
    async (baseUrl, fingerprint256) => {
      const client = new ProxmoxClient(
        { ...connection(baseUrl), certificateFingerprint: fingerprint256 },
        { tokenSecret: 'secret' },
        2000
      );
      const resources = await client.getClusterResources();
      assert.deepEqual(resources, []);
    }
  );
});

test('uses a discovered certificate fingerprint for pinned API requests', async () => {
  await withSelfSignedServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    },
    async (baseUrl, fingerprint256) => {
      const discoveredFingerprint = await readCertificateFingerprint(baseUrl);
      assert.equal(discoveredFingerprint, fingerprint256);
      const client = new ProxmoxClient(
        { ...connection(baseUrl), certificateFingerprint: discoveredFingerprint },
        { tokenSecret: 'secret' },
        2000
      );
      assert.deepEqual(await client.getClusterResources(), []);
    }
  );
});

test('accepts case-insensitive pinned certificate fingerprints', async () => {
  await withSelfSignedServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    },
    async (baseUrl, fingerprint256) => {
      const client = new ProxmoxClient(
        { ...connection(baseUrl), certificateFingerprint: fingerprint256.toLowerCase() },
        { tokenSecret: 'secret' },
        2000
      );
      assert.deepEqual(await client.getClusterResources(), []);
    }
  );
});

test('accepts pinned certificate fingerprints without colons', async () => {
  await withSelfSignedServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    },
    async (baseUrl, fingerprint256) => {
      const client = new ProxmoxClient(
        { ...connection(baseUrl), certificateFingerprint: fingerprint256.replaceAll(':', '') },
        { tokenSecret: 'secret' },
        2000
      );
      assert.deepEqual(await client.getClusterResources(), []);
    }
  );
});

test('rejects invalid trusted certificate fingerprints before the request is sent', async () => {
  await assert.rejects(
    () => new ProxmoxClient(
      { ...connection(), certificateFingerprint: 'not-a-fingerprint' },
      { tokenSecret: 'secret' },
      2000
    ).getClusterResources(),
    /trusted Proxmox certificate fingerprint is invalid/
  );
});

test('rejects API token secrets containing ASCII control characters', () => {
  assert.throws(
    () => new ProxmoxClient(
      { ...connection(), certificateFingerprint: canonicalFingerprint },
      { tokenSecret: 'secret\r\nX-Injected: yes' },
      2000
    ),
    /contains invalid control characters/
  );
});

test('accepts pinned certificates for IPv6 Proxmox URLs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pve-cert-ipv6-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes', '-subj', '/CN=localhost'
    ]);
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const fingerprint256 = new X509Certificate(cert).fingerprint256;
    const server = https.createServer({ key, cert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise((resolve, reject) => {
      server.listen(0, '::1', () => {
        const { port } = server.address();
        new ProxmoxClient(
          { ...connection(`https://[::1]:${port}`), certificateFingerprint: fingerprint256 },
          { tokenSecret: 'secret' },
          2000
        ).getClusterResources()
          .then((resources) => {
            assert.deepEqual(resources, []);
            resolve();
          }, reject)
          .finally(() => server.close());
      });
      server.on('error', reject);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sends POST requests over a pinned certificate and parses the task response', async () => {
  await withSelfSignedServer(
    (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/api2/json/nodes/pve1/lxc/101/status/start');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: 'UPID:pve1:start:101' }));
    },
    async (baseUrl, fingerprint256) => {
      const client = new ProxmoxClient(
        { ...connection(baseUrl), certificateFingerprint: fingerprint256 },
        { tokenSecret: 'secret' },
        2000
      );
      assert.equal(await client.startGuest('lxc', 'pve1', 101), 'UPID:pve1:start:101');
    }
  );
});

test('rejects truncated chunked responses before accepting the body', async () => {
  const payload = Buffer.from(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '5\r\nWiki\r\n' +
    '0\r\n'
  );
  assert.throws(() => parsePinnedResponse(payload), /invalid response/);
});

test('rejects changed pinned certificates with a certificate mismatch error', async () => {
  let receivedRequest = false;
  await withSelfSignedServer(
    (req, res) => {
      receivedRequest = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    },
    async (baseUrl) => {
      const client = new ProxmoxClient(
        { ...connection(baseUrl), certificateFingerprint: 'AA'.repeat(32) },
        { tokenSecret: 'secret' },
        2000
      );
      await assert.rejects(
        () => client.getClusterResources(),
        /certificate does not match/
      );
      assert.equal(receivedRequest, false);
    }
  );
});
test('repeated pinned-certificate requests never see a resumed handshake without a certificate', async () => {
  await withSelfSignedServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    },
    async (baseUrl, fingerprint256) => {
      const client = new ProxmoxClient(
        { ...connection(baseUrl), certificateFingerprint: fingerprint256 },
        { tokenSecret: 'secret' },
        2000
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.deepEqual(await client.getClusterResources(), []);
      }
    }
  );
});

test('uses only read-only HTTP methods', async () => {
  const originalFetch = global.fetch;
  const methods = [];
  global.fetch = async (_url, options) => {
    methods.push(options.method);
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
  };

  try {
    const client = new ProxmoxClient(connection(), { tokenSecret: 'secret' });
    await client.getClusterResources();
    await client.getStorage('node-a');
    assert.deepEqual(methods, ['GET', 'GET']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('starts a guest with POST and waits for the task to finish', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    return requests.length === 1
      ? { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: 'UPID:pve1:start:101' }) }
      : { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: { status: 'stopped', exitstatus: 'OK' } }) };
  };

  try {
    const client = new ProxmoxClient(connection(), { tokenSecret: 'secret' });
    const task = await client.startGuest('lxc', 'pve1', 101);
    await client.waitForTask('pve1', task);
    assert.deepEqual(requests, [
      { url: 'https://host:8006/api2/json/nodes/pve1/lxc/101/status/start', method: 'POST' },
      { url: 'https://host:8006/api2/json/nodes/pve1/tasks/UPID%3Apve1%3Astart%3A101/status', method: 'GET' }
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects a failed guest action task', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { status: 'stopped', exitstatus: 'ERROR: action failed' } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('pve1', 'UPID:test'),
      /Proxmox task failed/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects unknown task statuses instead of polling forever', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { status: 'failed', exitstatus: 'ERROR' } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('node-a', 'UPID:test'),
      /invalid task status/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects stopped tasks without a string exit status', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { status: 'stopped' } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('node-a', 'UPID:test'),
      /invalid task status/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects task statuses with a non-string exit status', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { status: 'stopped', exitstatus: { value: 'OK' } } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('node-a', 'UPID:test'),
      /invalid task status/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('times out task polling at the configured deadline', async () => {
  await assert.rejects(
    () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('node-a', 'UPID:test', undefined, 0),
    /deadline must be greater than zero/
  );
});

test('rejects waitForTask arguments before making a request', async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: { status: 'stopped', exitstatus: 'OK' } })
    };
  };

  try {
    const client = new ProxmoxClient(connection(), { tokenSecret: 'secret' });
    await assert.rejects(() => client.waitForTask(' ', 'UPID:test'), /node name is missing/);
    await assert.rejects(() => client.waitForTask('node-a', '  '), /task identifier is missing/);
    await assert.rejects(() => client.waitForTask('node-a', 'UPID:test', undefined, -1), /deadline must be greater than zero/);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('formats scalar API error payload values in failed responses', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Server Error',
    json: async () => ({ errors: { code: 123, detail: { reason: 'boom' } } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(),
      (error) => error instanceof ProxmoxApiError
        && error.message.includes('123')
        && error.message.includes('{"reason":"boom"}')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('trims task IDs returned by the API', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: ' UPID:test ' })
  });

  try {
    const taskId = await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).startGuest('lxc', 'node-a', 101);
    assert.equal(taskId, 'UPID:test');
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects malformed guest action task status responses', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { exitstatus: 'OK' } })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('pve1', 'UPID:test'),
      (error) => error instanceof ProxmoxApiError && error.message.includes('invalid task status')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('aborts requests when the caller cancels', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => await new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const controller = new AbortController();

  try {
    const request = new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(controller.signal);
    controller.abort();
    await assert.rejects(request, (error) => error instanceof ProxmoxApiError && error.message.includes('cancelled'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects pre-aborted requests before starting network work', async () => {
  const originalFetch = global.fetch;
  let networkStarted = false;
  global.fetch = async () => {
    networkStarted = true;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
  };
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources(controller.signal),
      (error) => error instanceof ProxmoxApiError && error.message.includes('cancelled')
    );
    assert.equal(networkStarted, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('times out while waiting for a response body', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => await new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });

  try {
    await assert.rejects(
      () => new ProxmoxClient(connection(), { tokenSecret: 'secret' }, 10).getClusterResources(),
      (error) => error instanceof ProxmoxApiError && error.message.includes('timed out')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('encodes node names in storage requests', async () => {
  const originalFetch = global.fetch;
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
  };
  try {
    await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node/a');
    assert.equal(requestedUrl, 'https://host:8006/api2/json/nodes/node%2Fa/storage');
  } finally {
    global.fetch = originalFetch;
  }
});

test('sends the authorization header without exposing it in errors', async () => {
  const originalFetch = global.fetch;
  let authorization;
  global.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
  };
  try {
    await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getClusterResources();
    assert.equal(authorization, 'PVEAPIToken=user@pve!token=secret');
  } finally {
    global.fetch = originalFetch;
  }
});

test('returns an empty storage list from an empty API array', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) });
  try {
    assert.deepEqual(await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).getStorage('node-a'), []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('uses the stop endpoint for stopGuest', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, method: options.method };
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: 'UPID:stop' }) };
  };
  try {
    await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).stopGuest('qemu', 'node-a', 42);
    assert.deepEqual(request, { url: 'https://host:8006/api2/json/nodes/node-a/qemu/42/status/stop', method: 'POST' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('accepts a stopped task with an OK exit status', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { status: 'stopped', exitstatus: 'OK' } })
  });
  try {
    await new ProxmoxClient(connection(), { tokenSecret: 'secret' }).waitForTask('node-a', 'UPID:ok');
  } finally {
    global.fetch = originalFetch;
  }
});
