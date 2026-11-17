import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { accessInfo } from '../server/access.mjs';
import { createWebServer } from '../server/http.mjs';

const ip = (address, internal = false) => ({ address, internal });
const interfaces = {
  'VMware Network Adapter VMnet8': [ip('192.168.127.1')],
  Ethernet: [ip('172.16.1.5')],
  WLAN: [ip('10.52.47.218'), ip('fe80::1')],
  Loopback: [ip('127.0.0.1', true)],
  Unconnected: [ip('169.254.1.2')],
  Invalid: [ip('invalid'), ip('0.0.0.0'), ip('224.0.0.1')]
};

test('phone access uses actual listener port, prefers Wi-Fi and skips virtual or unusable addresses', () => {
  const info = accessInfo({ interfaces, host: '0.0.0.0', port: 8790, now: 123 });
  assert.equal(info.updatedAt, 123);
  assert.deepEqual(info.addresses, [
    { name: 'WLAN', url: 'http://10.52.47.218:8790/', scope: 'lan' },
    { name: 'Ethernet', url: 'http://172.16.1.5:8790/', scope: 'lan' }
  ]);
  assert.deepEqual(accessInfo({ interfaces, host: '127.0.0.1', port: 8790 }).addresses, []);
  assert.deepEqual(accessInfo({ interfaces, host: '172.16.1.5', port: 8790 }).addresses.map(a => a.url), ['http://172.16.1.5:8790/']);
  assert.equal(accessInfo({ interfaces, host: '::', port: 8790 }).addresses.length, 2);
});

test('configured public access has priority; QR addresses never include credentials, query tokens or fragments', () => {
  const options = { interfaces, host: '0.0.0.0', port: 8787 };
  const info = accessInfo({ ...options, publicUrl: 'https://pv.example.com/?token=secret#password' });
  assert.deepEqual(info.addresses[0], { name: 'HTTPS / HTTP', url: 'https://pv.example.com/', scope: 'public' });
  assert(!JSON.stringify(info).includes('secret'));
  for (const publicUrl of ['javascript:alert(1)', 'https://user:secret@example.com/', 'not-a-url']) {
    const result = accessInfo({ ...options, publicUrl });
    assert(result.addresses.every(a => a.scope === 'lan'));
    assert(!JSON.stringify(result).includes('secret'));
  }
});

test('phone access API is authenticated, uncacheable, live and independent of request Host', async () => {
  let liveInterfaces = interfaces;
  const web = createWebServer({ hub: new EventEmitter(), password: 'Access-Test-Password-2026', dist: 'dist',
    getNetworkInterfaces: () => liveInterfaces });
  web.server.listen(0, '0.0.0.0'); await once(web.server, 'listening');
  const port = web.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + '/api/access')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Access-Test-Password-2026' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(base + '/api/access', { headers: { cookie, host: 'untrusted.example.com:9999' } });
    assert.match(response.headers.get('cache-control'), /no-store/);
    const first = await response.json();
    assert.equal(first.addresses[0].url, `http://10.52.47.218:${port}/`);
    assert(!JSON.stringify(first).includes('untrusted'));
    liveInterfaces = { WLAN: [ip('192.168.43.20')] };
    const updated = await (await fetch(base + '/api/access', { headers: { cookie } })).json();
    assert.deepEqual(updated.addresses, [{ name: 'WLAN', url: `http://192.168.43.20:${port}/`, scope: 'lan' }]);
  } finally { await web.close(); }
});
