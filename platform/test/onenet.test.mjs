import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import createAedes from 'aedes';
import { makeOneNetToken } from '../server/onenet-token.mjs';
import { OneNetLink, bindOneNetHub, oneNetProperties, verifyOneNetIdentity } from '../server/onenet.mjs';
import { Store } from '../server/store.mjs';
import { Hub } from '../server/hub.mjs';

const credentials = { productId: 'TEST_PID', deviceName: 'TEST_DEVICE', deviceKey: Buffer.from('test-only-device-secret-123456789').toString('base64') };
const fixture = () => ({ type: 'data', protocol: 3, seq: 1, uptimeS: 1, current: 123, panelTemp: 24.5,
  rain: null, dustLevel: null, tiltAngle: 30, targetAngle: 30, cleaning: false, mode: 'manual', alarm: 0,
  quality: 'uncalibrated', baselineMa: 0, dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10,
  autoCooldownS: 900, adcCurrent: 1500, adcVoltage: 3072, temperatureRaw: 26600,
  validFlags: 3, temperatureStatus: 'ok', saved: false });
async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await sleep(20); }
  assert.fail('Timed out waiting for test broker');
}

test('OneNET Token signs decoded device key and raw resource; URL-encodes token values', () => {
  const expiresAt = 1900000000;
  const token = makeOneNetToken({ ...credentials, expiresAt });
  const params = new URLSearchParams(token);
  const resource = 'products/TEST_PID/devices/TEST_DEVICE';
  const expected = createHmac('sha256', Buffer.from(credentials.deviceKey, 'base64'))
    .update([String(expiresAt), 'sha256', resource, '2018-10-31'].join('\n')).digest('base64');
  assert.equal(params.get('res'), resource);
  assert.equal(params.get('sign'), expected);
  assert.equal(params.get('et'), String(expiresAt));
  assert.match(token, /res=products%2FTEST_PID%2Fdevices%2FTEST_DEVICE/);
  assert.match(token, /sign=.*%3D/);
  assert.throws(() => makeOneNetToken({ ...credentials, expiresAt, deviceKey: 'not-a-base64-key' }));
  assert.throws(() => makeOneNetToken({ ...credentials, expiresAt, deviceName: 'a/b' }));
  assert.throws(() => new OneNetLink({ ...credentials, url: 'mqtt://mqtts.heclouds.com:1883' }));
});

test('OneNET only exposes fresh protocol-3 valid measurements; never fabricates missing fields', () => {
  const data = fixture();
  assert.deepEqual(oneNetProperties(data, 1000, 1001), { current: 123, panelTemp: 24.5, tiltAngle: 30 });
  assert.deepEqual(oneNetProperties(data, 1000, 6000), {});
  assert.deepEqual(oneNetProperties(data, 1000, 999), {});
  assert.deepEqual(oneNetProperties({ ...data, protocol: 2 }, 1000, 1001), {});
  assert.deepEqual(oneNetProperties({ ...data, current: null, panelTemp: null, validFlags: 0,
    temperatureStatus: 'missing', quality: 'invalid' }, 1000, 1001), { tiltAngle: 30 });
  assert.deepEqual(oneNetProperties({ ...data, panelTemp: 90, validFlags: 0 }, 1000, 1001), {});
});

test('OneNET TLS pins the exact official certificate and endpoint, never arbitrary certificates', () => {
  const certificate = new X509Certificate(readFileSync(new URL('../certs/onenet/certificate.pem', import.meta.url)));
  assert.equal(verifyOneNetIdentity('mqttstls.heclouds.com', certificate), undefined);
  assert(verifyOneNetIdentity('other.example.com', certificate) instanceof Error);
  assert(verifyOneNetIdentity('mqttstls.heclouds.com', { raw: Buffer.from('untrusted certificate') }) instanceof Error);
  assert(verifyOneNetIdentity('mqttstls.heclouds.com', {}) instanceof Error);
});

class Device extends EventEmitter {
  connected = true;
  sent = [];
  result = { accepted: true, applied: true, reason: 'OK' };
  status() { return { connected: this.connected }; }
  send(command) {
    this.sent.push(command);
    if (this.result) setTimeout(() => this.emit('ack', { type: 'ack', cmdId: command.cmdId, ...this.result }), 5);
  }
  async close() {}
}

test('OneNET adds real PIR/NTC properties, confirms receipts, preserves base posts on model rejection, and refuses writes', async () => {
  const broker = createAedes(), tcp = net.createServer(broker.handle);
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  let clock = Date.now();
  const link = new OneNetLink({ ...credentials, url: `mqtt://127.0.0.1:${tcp.address().port}`, allowInsecure: true, now: () => clock });
  const data = { ...fixture(), personDetected: true, pirStatus: 'ok', pirWarmupRemainingS: 0,
    ld1Mode: 'alarm', alarm: 16, ntcAdc: 1940, ntcStatus: 'estimated', surfaceTemp: 27.4, pirAlarmEnabled: true };
  link.snapshot = () => ({ online: true, simulation: false, data, receivedAt: clock });
  const posts = [], replies = [];
  broker.on('publish', (packet, client) => {
    if (!client) return;
    const body = JSON.parse(packet.payload.toString());
    if (packet.topic === link.prefix + 'post') posts.push(body);
    if (packet.topic.endsWith('_reply')) replies.push(body);
  });
  const send = (kind, body) => new Promise((resolve, reject) => broker.publish({
    topic: link.prefix + kind, payload: Buffer.from(JSON.stringify(body)), qos: 0, retain: false
  }, error => error ? reject(error) : resolve()));
  try {
    await until(() => link.connected);
    await link.publish('data', { ...data, sentAt: clock });
    await until(() => posts.length === 1);
    assert.equal(posts[0].params.personDetected.value, true);
    assert.equal(posts[0].params.surfaceTemp.value, 27.4);
    assert.equal(posts[0].params.panelTemp.value, 24.5);
    assert.equal(link.status().lastReportAt, null);
    await send('post/reply', { id: posts[0].id, code: 2406 });
    await until(() => link.status().extensionReportError !== null);
    assert.equal(link.status().reportError, 'ONENET_MODEL_REJECTED');
    clock += 5000;
    await link.publish('data', { ...data, sentAt: clock });
    await until(() => posts.length === 2);
    assert.deepEqual(Object.keys(posts[1].params), ['current', 'panelTemp', 'tiltAngle']);
    await send('post/reply', { id: posts[1].id, code: 200 });
    await until(() => link.status().lastPostCode === 200);
    assert.equal(link.status().reportError, null);
    assert.equal(link.status().extensionReportError, 'ONENET_EXTENSION_MODEL_REJECTED');
    assert.equal(link.status().lastReportFields.includes('surfaceTemp'), false);
    clock += 60000;
    await link.publish('data', { ...data, sentAt: clock });
    await until(() => posts.length === 3);
    assert.equal(posts[2].params.surfaceTemp.value, 27.4);
    await send('post/reply', { id: posts[2].id, code: 200 });
    await until(() => link.status().extensionReportError === null);
    assert.equal(link.status().lastReportFields.includes('personDetected'), true);
    assert.equal(link.status().lastReportFields.includes('surfaceTemp'), true);
    await send('get', { id: '501', version: '1.0', params: ['personDetected', 'surfaceTemp', 'panelTemp'] });
    await until(() => replies.some(r => r.id === '501'));
    assert.deepEqual(replies.find(r => r.id === '501').data, { personDetected: true, surfaceTemp: 27.4, panelTemp: 24.5 });
    for (const [id, params] of [['502', { personDetected: false }], ['503', { surfaceTemp: 30 }]]) {
      await send('set', { id, version: '1.0', params });
      await until(() => replies.some(r => r.id === id));
      assert.equal(replies.find(r => r.id === id).code, 400);
    }
    data.personDetected = false; data.alarm = 0; data.ld1Mode = 'idle';
    data.ntcAdc = 129; data.ntcStatus = 'invalid'; data.surfaceTemp = null;
    clock += 5000;
    await link.publish('data', { ...data, sentAt: clock });
    await until(() => posts.length === 4);
    assert.equal(posts[3].params.personDetected.value, false);
    assert.equal(Object.hasOwn(posts[3].params, 'surfaceTemp'), false);
    await send('get', { id: '504', version: '1.0', params: ['surfaceTemp'] });
    await until(() => replies.some(r => r.id === '504'));
    assert.equal(replies.find(r => r.id === '504').code, 503);
  } finally {
    await link.close();
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => tcp.close(resolve));
  }
});

test('OneNET auth, posts/business receipts, real ACK, duplicate rejection, GET and renewal', async () => {
  const broker = createAedes();
  const authTokens = [];
  broker.authenticate = (client, username, password, callback) => {
    authTokens.push(password?.toString());
    const token = new URLSearchParams(password?.toString());
    callback(null, client.id === credentials.deviceName && username === credentials.productId &&
      token.get('res') === `products/${credentials.productId}/devices/${credentials.deviceName}`);
  };
  const tcp = net.createServer(broker.handle);
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  let clock = Date.now();
  const link = new OneNetLink({ ...credentials, url: `mqtt://127.0.0.1:${tcp.address().port}`, allowInsecure: true, now: () => clock });
  const store = new Store(':memory:');
  const device = new Device();
  const hub = new Hub({ store, transport: device, retryMs: 30 });
  bindOneNetHub(link, hub);
  const posts = [], replies = [];
  broker.on('publish', (packet, client) => {
    if (!client) return;
    const body = JSON.parse(packet.payload.toString());
    if (packet.topic === link.prefix + 'post') posts.push(body);
    if (packet.topic.endsWith('_reply')) replies.push({ topic: packet.topic, ...body });
  });
  const send = (kind, body, retain = false) => new Promise((resolve, reject) => broker.publish({
    topic: link.prefix + kind, payload: Buffer.from(JSON.stringify(body)), qos: 0, retain
  }, error => error ? reject(error) : resolve()));
  try {
    await until(() => link.connected);
    assert.equal(authTokens.length, 1);
    assert.equal(Number(new URLSearchParams(authTokens[0]).get('et')) - Math.floor(clock / 1000), 86400, 'default Token lifetime is 24 hours');
    assert.equal(link.status().lastReportAt, null);
    assert(!JSON.stringify(link.status()).includes(credentials.deviceKey));
    hub.ingest(fixture());
    clock = hub.receivedAt;
    await link.publish('data', { ...hub.data, sentAt: clock });
    await until(() => posts.length === 1);
    assert.deepEqual(Object.keys(posts[0].params), ['current', 'panelTemp', 'tiltAngle']);
    assert.deepEqual(posts[0].params.panelTemp, { value: 24.5, time: clock });
    assert.match(posts[0].id, /^[0-9]{1,13}$/);
    assert.equal(link.status().lastReportAt, null, 'MQTT delivery is not business success');
    await send('post/reply', { id: '999', code: 200 });
    await sleep(30); assert.equal(link.status().lastReportAt, null);
    await send('post/reply', { id: posts[0].id, code: 200 });
    await until(() => link.status().lastReportAt !== null);
    const set = { id: '101', version: '1.0', params: { tiltAngle: 45 } };
    await send('set', set);
    await until(() => replies.some(r => r.id === '101'));
    assert.equal(replies.find(r => r.id === '101').code, 200);
    assert.equal(device.sent.length, 1);
    assert.equal(device.sent[0].value, 45);
    assert.equal(hub.data.tiltAngle, 30, 'requested value never substitutes for telemetry');
    await send('set', set);
    await until(() => replies.filter(r => r.id === '101').length === 2);
    assert.equal(device.sent.length, 1, 'duplicate OneNET request must not actuate twice');
    await send('set', { ...set, params: { tiltAngle: 60 } });
    await until(() => replies.filter(r => r.id === '101').length === 3);
    assert.equal(replies.at(-1).msg, 'ID_CONFLICT');
    for (const [id, params] of [['102', { rain: 0 }], ['103', { tiltAngle: 91 }], ['104', { tiltAngle: 4.5 }]]) {
      await send('set', { id, version: '1.0', params });
      await until(() => replies.some(r => r.id === id));
      assert.equal(replies.find(r => r.id === id).code, 400);
    }
    await link.receive(link.prefix + 'set', Buffer.from(JSON.stringify({ ...set, id: '105' })), { retain: true });
    assert.equal(device.sent.length, 1);
    await send('get', { id: '201', version: '1.0', params: ['panelTemp', 'tiltAngle'] });
    await until(() => replies.some(r => r.id === '201'));
    assert.deepEqual(replies.find(r => r.id === '201').data, { panelTemp: 24.5, tiltAngle: 30 });
    await send('get', { id: '202', version: '1.0', params: ['rain'] });
    await until(() => replies.some(r => r.id === '202'));
    assert.equal(replies.find(r => r.id === '202').code, 503);
    device.result = { accepted: false, applied: false, reason: 'BUSY' };
    await send('set', { ...set, id: '106' });
    await until(() => replies.some(r => r.id === '106'));
    assert.equal(replies.find(r => r.id === '106').msg, 'BUSY');
    device.result = null;
    await send('set', { ...set, id: '107' });
    await until(() => replies.some(r => r.id === '107'));
    assert.equal(replies.find(r => r.id === '107').msg, 'NO_ACK_TIMEOUT');
    const sent = device.sent.length;
    device.connected = false;
    await send('set', { ...set, id: '108' });
    await until(() => replies.some(r => r.id === '108'));
    assert.equal(replies.find(r => r.id === '108').msg, 'DEVICE_OFFLINE');
    assert.equal(device.sent.length, sent);
    clock += 6000;
    link.flush(); await sleep(30);
    assert.equal(posts.length, 1, 'stale data is not uploaded again');
    link.renew();
    await until(() => authTokens.length === 2 && link.connected);
    assert.notEqual(authTokens[0], authTokens[1], 'reconnect uses a freshly signed token');
    assert.equal(Number(new URLSearchParams(authTokens[1]).get('et')) - Math.floor(clock / 1000), 86400, 'renewed Token lifetime is 24 hours');
    assert.equal(posts.length, 1);
    await link.publish('data', { ...fixture(), sentAt: clock });
    await until(() => posts.length === 2);
    await send('post/reply', { id: posts[1].id, code: 2406 });
    await until(() => link.status().reportError === 'ONENET_MODEL_REJECTED');
    assert.equal(link.status().lastPostCode, 2406);
  } finally {
    await link.close(); await hub.close(); store.close();
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => tcp.close(resolve));
  }
});
