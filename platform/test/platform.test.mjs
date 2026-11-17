import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import createAedes from 'aedes';
import { Store } from '../server/store.mjs';
import { Hub } from '../server/hub.mjs';
import { createWebServer } from '../server/http.mjs';
import { validateCommand, validateData, validateAck } from '../server/contract.mjs';
import { MqttLink, CloudTransport, SerialTransport, Simulator } from '../server/transport.mjs';

const fixture = (seq = 1) => ({ type: 'data', protocol: 3, seq, uptimeS: seq,
  current: 700, panelTemp: 30, rain: 0, dustLevel: null, tiltAngle: 30, targetAngle: 30,
  cleaning: false, mode: 'manual', alarm: 0, quality: 'uncalibrated', baselineMa: 0,
  dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10, autoCooldownS: 900,
  adcCurrent: 2600, adcVoltage: 1024, temperatureRaw: 28660, validFlags: 7, temperatureStatus: 'ok', saved: false });
class Fake extends EventEmitter {
  connected = true;
  sent = [];
  result = null;
  status() { return { kind: 'test', connected: this.connected }; }
  send(cmd) {
    this.sent.push(cmd);
    if (this.result) setTimeout(() => this.emit('ack', { type: 'ack', cmdId: cmd.cmdId, ...this.result }), 2);
  }
  async close() {}
}
const makeHub = (transport = new Fake(), role = 'gateway') => new Hub({ store: new Store(':memory:'), transport, role, retryMs: 15 });
const closeHub = async hub => { await hub.close(); hub.store.close(); };

test('command whitelist rejects fractions, extra fields and prototype names', () => {
  assert.deepEqual(validateCommand({ action: 'angle', value: 90 }), { action: 'angle', value: 90 });
  for (const body of [{ action: 'angle', value: 90.1 }, { action: 'angle', value: -1 },
    { action: 'clean', value: 1, injected: 1 }, { action: 'constructor', value: 1 },
    { action: 'settings', dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10, autoCooldownS: 900, constructor: 1 }])
    assert.throws(() => validateCommand(body));
  assert.equal(validateData({ ...fixture(), current: Infinity }), null);
  assert.equal(validateData({ ...fixture(), cleaning: 1 }), null);
  assert.equal(validateAck({ type: 'ack', cmdId: 'a'.repeat(32), accepted: false, applied: true, reason: 'OK' }), false);
});

test('offline requests are audited, rejected and never sent', async () => {
  const hub = makeHub();
  try {
    const ack = await hub.command({ action: 'clean', value: 1 });
    assert.equal(ack.reason, 'DEVICE_OFFLINE'); assert.equal(ack.applied, false);
    assert.equal(hub.transport.sent.length, 0); assert.equal(hub.store.logs()[0].ack.reason, 'DEVICE_OFFLINE');
  } finally { await closeHub(hub); }
});

test('sensor validity is per channel; missing/CRC data must be null, not zero or last value', () => {
  const missing = { ...fixture(), current: null, panelTemp: null, rain: null, dustLevel: null,
    validFlags: 0, quality: 'invalid', temperatureStatus: 'missing' };
  assert.ok(validateData(missing));
  assert.equal(validateData({ ...missing, current: 281 }), null);
  assert.equal(validateData({ ...missing, panelTemp: 90 }), null);
  assert.equal(validateData({ ...missing, rain: 0 }), null);
  assert.ok(validateData({ ...fixture(), panelTemp: -2.9 }));
  assert.equal(validateData({ ...fixture(), temperatureStatus: 'crc' }), null);
  assert.ok(validateData({ ...fixture(), validFlags: 3, rain: null }));
});

test('legacy ADC-as-temperature firmware is masked in live/history and cannot start outputs', async () => {
  const hub = makeHub();
  try {
    hub.ingest({ ...fixture(), protocol: 2, panelTemp: 90, adcTemp: 3072 });
    assert.equal(hub.data.panelTemp, null);
    assert.equal(hub.data.current, null);
    assert.equal(hub.data.temperatureStatus, 'legacy');
    assert.equal(hub.store.history(1)[0].panelTemp, null);
    const ack = await hub.command({ action: 'clean', value: 1 });
    assert.equal(ack.reason, 'FIRMWARE_UPDATE_REQUIRED');
    assert.equal(hub.transport.sent.length, 0);
  } finally { await closeHub(hub); }
});

test('ACK registry retries the same ID exactly three times and never invents success', async () => {
  const hub = makeHub();
  try {
    hub.ingest(fixture());
    const ack = await hub.command({ action: 'angle', value: 45 });
    assert.equal(ack.reason, 'NO_ACK_TIMEOUT');
    assert.equal(hub.transport.sent.length, 3);
    assert.equal(new Set(hub.transport.sent.map(c => c.cmdId)).size, 1);
    assert.equal(hub.snapshot().data.targetAngle, 30);
  } finally { await closeHub(hub); }
});

test('real device rejection and authoritative telemetry are kept separate', async () => {
  const hub = makeHub();
  try {
    hub.ingest(fixture());
    hub.transport.result = { accepted: false, applied: false, reason: 'RAIN_INTERLOCK' };
    const ack = await hub.command({ action: 'clean', value: 1 });
    assert.equal(ack.reason, 'RAIN_INTERLOCK'); assert.equal(hub.store.logs()[0].ack.applied, false);
    assert.equal(hub.snapshot().data.cleaning, false);
    hub.transport.result = { accepted: true, applied: true, reason: 'OK' };
    await hub.command({ action: 'angle', value: 60 });
    assert.equal(hub.snapshot().data.targetAngle, 30);
    hub.ingest({ ...fixture(2), targetAngle: 60 });
    assert.equal(hub.snapshot().data.targetAngle, 60);
    assert.equal(hub.ingest({ ...fixture(2), targetAngle: 60 }), false);
    assert.equal(hub.store.history(1).length, 1);
  } finally { await closeHub(hub); }
});

test('HTTP authentication, origin checks, SSE, CSV, audit and logout', async () => {
  const hub = makeHub(); hub.ingest(fixture());
  hub.transport.result = { accepted: true, applied: true, reason: 'OK' };
  const web = createWebServer({ hub, password: 'A-Test-Password-2026', dist: path.resolve('dist') });
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening');
  const base = `http://127.0.0.1:${web.server.address().port}`;
  let reader;
  try {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'A-Test-Password-2026' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const headers = { cookie, 'Content-Type': 'application/json' };
    const denied = await fetch(base + '/api/command', { method: 'POST', headers: { ...headers, origin: 'http://evil.example' }, body: JSON.stringify({ action: 'clean', value: 1 }) });
    assert.equal(denied.status, 403);
    const ack = await (await fetch(base + '/api/command', { method: 'POST', headers, body: JSON.stringify({ action: 'angle', value: 45 }) })).json();
    assert.equal(ack.applied, true);
    const events = await fetch(base + '/api/events', { headers: { cookie } });
    assert.match(events.headers.get('content-type'), /text\/event-stream/);
    reader = events.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: snapshot/); assert.match(first, /"targetAngle":30/);
    const csv = await fetch(base + '/api/export.csv?hours=1', { headers: { cookie } });
    assert.match(await csv.text(), /current,panelTemp,rain/);
    const audit = await (await fetch(base + '/api/logs', { headers: { cookie } })).json();
    assert.equal(audit[0].cmdId, ack.cmdId); assert.equal(audit[0].ack.applied, true);
    assert.equal((await fetch(base + '/api/history?hours=999', { headers: { cookie } })).status, 400);
    await reader.cancel(); reader = null;
    await fetch(base + '/api/logout', { method: 'POST', headers });
    assert.equal((await fetch(base + '/api/state', { headers: { cookie } })).status, 401);
  } finally { await reader?.cancel(); await web.close(); await closeHub(hub); }
});

test('serial framing ignores malformed/oversized lines and emits only complete JSON frames', async () => {
  const transport = new SerialTransport();
  try {
    const data = [], ack = [];
    transport.on('data', d => data.push(d)); transport.on('ack', a => ack.push(a));
    const line = JSON.stringify(fixture()) + '\r\n';
    transport.receive(Buffer.from(line.slice(0, 20))); assert.equal(data.length, 0);
    transport.receive(Buffer.from(line.slice(20))); assert.equal(data.length, 1);
    transport.receive(Buffer.from('not json\n' + 'x'.repeat(5000) + '\n'));
    assert.equal(data.length, 1); assert.equal(ack.length, 0);
  } finally { await transport.close(); }
});

test('MQTT gateway -> cloud telemetry -> command -> actual device ACK roundtrip', async () => {
  const broker = createAedes(); const tcp = net.createServer(broker.handle);
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const url = `mqtt://127.0.0.1:${tcp.address().port}`;
  const options = { url, deviceId: 'PV_TEST', allowInsecure: true };
  const gatewayLink = new MqttLink({ ...options, role: 'gateway' });
  const cloudLink = new MqttLink({ ...options, role: 'cloud' });
  const fake = new Fake(); fake.result = { accepted: true, applied: true, reason: 'OK' };
  fake.upstream = (kind, data) => gatewayLink.publish(kind, data).catch(() => {});
  gatewayLink.on('command', cmd => fake.emit('command', cmd));
  const gateway = makeHub(fake), cloud = makeHub(new CloudTransport(cloudLink), 'cloud');
  gateway.retryMs = cloud.retryMs = 100;
  try {
    for (let i = 0; i < 100 && (!gatewayLink.connected || !cloudLink.connected); i++) await sleep(20);
    assert(gatewayLink.connected && cloudLink.connected);
    await sleep(60);
    gateway.ingest(fixture());
    for (let i = 0; i < 50 && !cloud.online(); i++) await sleep(10);
    assert(cloud.online());
    const ack = await cloud.command({ action: 'angle', value: 55 });
    assert.equal(ack.applied, true); assert.equal(fake.sent[0].value, 55);
    assert.equal(gateway.store.logs()[0].cmdId, cloud.store.logs()[0].cmdId);
    const sentBeforeReplay = fake.sent.length;
    await gatewayLink.client.unsubscribeAsync('pv/PV_TEST/cmd');
    await cloudLink.publish('cmd', { type: 'cmd', cmdId: 'f'.repeat(32), issuedAt: Date.now(), action: 'clean', value: 1 }, true);
    await gatewayLink.client.subscribeAsync('pv/PV_TEST/cmd', { qos: 1 });
    await sleep(60); assert.equal(fake.sent.length, sentBeforeReplay);
  } finally {
    await closeHub(gateway); await closeHub(cloud); await gatewayLink.close();
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => tcp.close(resolve));
  }
});

test('MCU-generated JSON is accepted by the same backend contract', { skip: !existsSync('../.build/tests/firmware_test.exe') }, () => {
  const lines = execFileSync(path.resolve('../.build/tests/firmware_test.exe'), ['--protocol'], { encoding: 'utf8' }).trim().split(/\r?\n/).map(JSON.parse);
  assert(validateData(lines[0])); assert(validateAck(lines[1])); assert.equal(lines[1].applied, true);
  assert.equal(lines[0].rainProtection, 'idle'); assert.equal(lines[0].motionPaused, false);
});

test('rain automation capability is atomic, typed and consistent, without inventing legacy status', () => {
  const data = { ...fixture(), rainProtection: 'idle', rainDryRemainingS: 0, motionPaused: false };
  assert.ok(validateData(data));
  assert.ok(validateData(fixture()));
  assert.equal(Object.hasOwn(validateData({ ...data, protocol: 2 }), 'motionPaused'), false);
  for (const bad of [{ motionPaused: 1 }, { rainDryRemainingS: 11 }, { rainProtection: 'fake' },
    { rainProtection: 'unavailable' }, { rainProtection: 'rain' }, { rainDryRemainingS: 1 },
    { motionPaused: true, cleaning: true }, { motionPaused: true, targetAngle: 90 }])
    assert.equal(validateData({ ...data, ...bad }), null);
  assert.equal(validateData({ ...fixture(), motionPaused: false }), null);
  assert.ok(validateData({ ...data, rain: 100, rainProtection: 'rain' }));
  assert.ok(validateData({ ...data, rain: null, validFlags: 3, rainProtection: 'unavailable' }));
  assert.ok(validateData({ ...data, rainProtection: 'drying', rainDryRemainingS: 10 }));
  assert.deepEqual(validateCommand({ action: 'resume', value: 1 }), { action: 'resume', value: 1 });
  assert.throws(() => validateCommand({ action: 'resume', value: 0 }));
});

test('resume on older firmware is audited and rejected without any serial transmission', async () => {
  const hub = makeHub();
  try {
    hub.ingest(fixture());
    const ack = await hub.command({ action: 'resume', value: 1 });
    assert.equal(ack.reason, 'FIRMWARE_UPDATE_REQUIRED');
    assert.equal(hub.transport.sent.length, 0);
    assert.equal(hub.store.logs()[0].ack.applied, false);
  } finally { await closeHub(hub); }
});

test('isolated simulator rain interlocks, STOP latch and explicit resume use actual ACK registry', async () => {
  const transport = new Simulator();
  clearInterval(transport.timer); clearTimeout(transport.first);
  const hub = makeHub(transport); hub.retryMs = 100;
  try {
    transport.tick();
    transport.state.baselineMa = 800;
    assert.equal((await hub.command({ action: 'mode', value: 1 })).applied, true);
    assert.equal((await hub.command({ action: 'clean', value: 1 })).applied, true);
    transport.state.rain = 100; transport.tick();
    assert.equal(hub.data.targetAngle, 90); assert.equal(hub.data.cleaning, false);
    assert.equal(hub.data.mode, 'manual'); assert.equal(hub.data.rainProtection, 'rain');
    assert.equal((await hub.command({ action: 'angle', value: 0 })).reason, 'RAIN_INTERLOCK');
    assert.equal((await hub.command({ action: 'stop', value: 1 })).applied, true);
    assert.equal(hub.data.motionPaused, true);
    transport.state.rain = 0; transport.tick();
    transport.dryAt = Date.now() - 11000; transport.tick();
    assert.equal(hub.data.targetAngle, 90);
    assert.equal((await hub.command({ action: 'clean', value: 1 })).reason, 'MOTION_PAUSED');
    assert.equal((await hub.command({ action: 'resume', value: 1 })).applied, true);
    transport.tick();
    assert.equal(hub.data.targetAngle, 0); assert.equal(hub.data.motionPaused, false);
    assert.equal(hub.data.cleaning, false); assert.equal(hub.data.mode, 'manual');
    assert.equal(hub.store.logs()[0].command.action, 'resume');
    assert.equal(hub.store.logs()[0].ack.applied, true);
  } finally { await closeHub(hub); }
});
