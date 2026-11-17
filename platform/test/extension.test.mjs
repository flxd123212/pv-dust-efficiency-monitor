import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Hub } from '../server/hub.mjs';
import { Simulator } from '../server/transport.mjs';
import { validateCommand, validateData, validateAck } from '../server/contract.mjs';
import { oneNetProperties } from '../server/onenet.mjs';
import { extensionState } from '../web/src/extension-state.js';

const keys = ['personDetected', 'pirStatus', 'pirWarmupRemainingS', 'ld1Mode', 'ntcAdc', 'ntcStatus', 'pirAlarmEnabled'];
const fixture = () => ({ type: 'data', protocol: 3, seq: 1, uptimeS: 61,
  current: 239, panelTemp: 23.4, rain: 0, dustLevel: null, tiltAngle: 0, targetAngle: 0,
  cleaning: false, mode: 'manual', alarm: 0, quality: 'uncalibrated', baselineMa: 0,
  dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10, autoCooldownS: 900,
  adcCurrent: 3000, adcVoltage: 1024, temperatureRaw: 26212, validFlags: 7, temperatureStatus: 'ok', saved: false,
  rainProtection: 'idle', rainDryRemainingS: 0, motionPaused: false,
  personDetected: false, pirStatus: 'ok', pirWarmupRemainingS: 0,
  ld1Mode: 'idle', ntcAdc: 2048, ntcStatus: 'unconfigured', pirAlarmEnabled: true });
const legacy = () => Object.fromEntries(Object.entries(fixture()).filter(([key]) => !keys.includes(key)));
class Controlled extends EventEmitter {
  connected = true;
  sent = [];
  status() { return { connected: true, kind: 'test' }; }
  send(cmd) {
    this.sent.push(cmd);
    setTimeout(() => this.emit('ack', { type: 'ack', cmdId: cmd.cmdId, accepted: true, applied: true, reason: 'OK' }), 1);
  }
  async close() {}
}
async function close(hub) { await hub.close(); hub.store.close(); }

test('PIR capability is atomic, typed, honest about warmup/missing, and consistent with alarm/LD1', () => {
  assert.ok(validateData(fixture()));
  for (const key of keys) {
    const data = fixture(); delete data[key];
    assert.equal(validateData(data), null, key);
  }
  for (const change of [{ personDetected: 0 }, { pirStatus: 'nearby' }, { pirWarmupRemainingS: 1 },
    { pirStatus: 'warming', personDetected: null }, { pirStatus: 'unavailable', personDetected: false },
    { pirStatus: 'warming', personDetected: null, pirWarmupRemainingS: 61 },
    { ntcAdc: 4096 }, { ntcAdc: -1 }, { ntcStatus: 'ok' }, { pirAlarmEnabled: 1 },
    { personDetected: true }, { alarm: 16, ld1Mode: 'alarm' },
    { personDetected: true, pirAlarmEnabled: false, alarm: 16, ld1Mode: 'alarm' },
    { cleaning: true }, { motionPaused: true, ld1Mode: 'idle' }]) {
    assert.equal(validateData({ ...fixture(), ...change }), null, JSON.stringify(change));
  }
  assert.ok(validateData({ ...fixture(), pirStatus: 'warming', personDetected: null, pirWarmupRemainingS: 60 }));
  assert.ok(validateData({ ...fixture(), pirStatus: 'unavailable', personDetected: null, ntcAdc: null }));
  assert.ok(validateData({ ...fixture(), pirStatus: 'unavailable', personDetected: null, panelTemp: null, validFlags: 5, temperatureStatus: 'missing' }));
  assert.equal(validateData({ ...fixture(), panelTemp: null, validFlags: 5, temperatureStatus: 'missing' }), null);
  assert.ok(validateData({ ...fixture(), personDetected: true, pirAlarmEnabled: false }));
  assert.ok(validateData({ ...fixture(), personDetected: true, alarm: 16, ld1Mode: 'alarm', cleaning: true, mode: 'auto' }));
  assert.ok(validateData({ ...fixture(), cleaning: true, ld1Mode: 'cleaning' }));
  assert.ok(validateData({ ...fixture(), motionPaused: true, ld1Mode: 'paused' }));
  assert.ok(validateData(legacy()));
  assert.equal(validateData({ ...legacy(), alarm: 16 }), null);
  for (const key of keys) assert.equal(Object.hasOwn(validateData({ ...fixture(), protocol: 2 }), key), false);
});

test('maintenance command accepts only binary integers; old firmware is rejected and audited without transmission', async () => {
  for (const value of [0, 1]) assert.deepEqual(validateCommand({ action: 'pirAlarm', value }), { action: 'pirAlarm', value });
  for (const value of [-1, 2, true, '0', 0.5]) assert.throws(() => validateCommand({ action: 'pirAlarm', value }));
  const transport = new Controlled(), hub = new Hub({ store: new Store(':memory:'), transport });
  try {
    hub.ingest(legacy());
    assert.equal((await hub.command({ action: 'pirAlarm', value: 0 })).reason, 'FIRMWARE_UPDATE_REQUIRED');
    assert.equal(transport.sent.length, 0);
    assert.equal(hub.store.logs()[0].ack.applied, false);
    hub.ingest({ ...fixture(), seq: 2 });
    assert.equal((await hub.command({ action: 'pirAlarm', value: 0 })).applied, true);
    assert.equal(hub.data.pirAlarmEnabled, true, 'ACK is not authoritative telemetry');
    hub.ingest({ ...fixture(), seq: 3, pirAlarmEnabled: false });
    assert.equal(hub.data.pirAlarmEnabled, false);
  } finally { await close(hub); }
});

test('isolated maintenance roundtrip retains motion and cleaning, suppresses only PIR, and records actual ACKs', async () => {
  const transport = new Simulator(); clearInterval(transport.timer); clearTimeout(transport.first);
  const hub = new Hub({ store: new Store(':memory:'), transport, retryMs: 100 });
  try {
    Object.assign(transport.state, { pirStatus: 'ok', personDetected: true, pirWarmupRemainingS: 0, baselineMa: 800 });
    transport.tick();
    assert.equal(hub.data.alarm, 16);
    assert.equal((await hub.command({ action: 'mode', value: 1 })).applied, true);
    assert.equal((await hub.command({ action: 'clean', value: 1 })).applied, true);
    assert.equal((await hub.command({ action: 'pirAlarm', value: 0 })).applied, true);
    assert.equal(hub.data.pirAlarmEnabled, false);
    assert.equal(hub.data.personDetected, true);
    assert.equal(hub.data.alarm, 0); assert.equal(hub.data.ld1Mode, 'cleaning');
    assert.equal(hub.data.cleaning, true); assert.equal(hub.data.mode, 'auto'); assert.equal(hub.data.targetAngle, 0);
    assert.equal((await hub.command({ action: 'pirAlarm', value: 1 })).applied, true);
    assert.equal(hub.data.alarm, 16); assert.equal(hub.data.cleaning, true);
    assert.equal((await hub.command({ action: 'pirAlarm', value: 0 })).applied, true);
    transport.state.rain = 100; transport.tick();
    assert.equal(hub.data.alarm, 4); assert.equal(hub.data.ld1Mode, 'alarm'); assert.equal(hub.data.targetAngle, 90);
    assert.equal(hub.data.personDetected, true); assert.equal(hub.data.cleaning, false);
    assert.equal(hub.store.logs()[0].command.action, 'pirAlarm');
    assert.equal(hub.store.logs()[0].ack.applied, true);
  } finally { await close(hub); }
});

test('extension UI keeps activity separate from maintenance, unknowns and raw thermistor diagnostics', () => {
  assert.equal(extensionState(null).pir, '等待设备');
  assert.equal(extensionState(legacy()).supported, false);
  assert.equal(extensionState(fixture()).pir, '未检测到活动');
  const motion = extensionState({ ...fixture(), personDetected: true, alarm: 16, ld1Mode: 'alarm' });
  assert.equal(motion.pir, '检测到人体活动'); assert.equal(motion.led, '报警闪烁'); assert.equal(motion.tone, 'alarm');
  const maintenance = extensionState({ ...fixture(), personDetected: true, pirAlarmEnabled: false });
  assert.equal(maintenance.pir, '检测到人体活动'); assert.equal(maintenance.tone, 'maintenance'); assert.equal(maintenance.enabled, false);
  assert.equal(maintenance.ntc, '-- °C'); assert.equal(maintenance.ntcDetail, '待更新固件 · ADC 2048');
  assert.equal(extensionState({ ...fixture(), pirStatus: 'warming', personDetected: null, pirWarmupRemainingS: 60 }).pir, '预热中 · 60 秒');
  assert.equal(extensionState({ ...fixture(), pirStatus: 'unavailable', personDetected: null }).pir, '传感器不可用');
});

test('MCU PIR/maintenance frames and real ACKs match server, UI and extended OneNET mapping', { skip: !existsSync('../.build/tests/firmware_test.exe') }, () => {
  const frames = execFileSync(path.resolve('../.build/tests/firmware_test.exe'), ['--pir-protocol'], { encoding: 'utf8' }).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(frames.length, 8);
  for (const frame of frames) assert.ok(frame.type === 'ack' ? validateAck(frame) && frame.applied : validateData(frame), JSON.stringify(frame));
  assert.equal(frames[0].pirStatus, 'warming'); assert.equal(frames[0].personDetected, null);
  assert.equal(frames[1].alarm, 16);
  assert.equal(frames[3].pirAlarmEnabled, false); assert.equal(frames[3].personDetected, true); assert.equal(frames[3].alarm, 0);
  assert.equal(frames[5].pirAlarmEnabled, true); assert.equal(frames[5].alarm, 16);
  assert.equal(frames[6].pirAlarmEnabled, false); assert.equal(frames[6].alarm, 4); assert.equal(frames[6].ld1Mode, 'alarm');
  assert.equal(frames[7].personDetected, null); assert.equal(frames[7].pirStatus, 'unavailable');
  assert.equal(extensionState(frames[3]).tone, 'maintenance');
  assert.equal(extensionState(frames[1]).ntc, '27.4 °C');
  assert.deepEqual(Object.keys(oneNetProperties(frames[1], 1000, 1000)).sort(), ['current', 'panelTemp', 'personDetected', 'rain', 'surfaceTemp', 'tiltAngle']);
  assert.equal(oneNetProperties(frames[1], 1000, 1000).panelTemp, 23.4);
});
