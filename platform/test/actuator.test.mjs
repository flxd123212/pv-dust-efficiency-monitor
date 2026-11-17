import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actuatorState } from '../web/src/actuator-state.js';

const fixture = () => ({ protocol: 3, validFlags: 7, rain: 0, panelTemp: 25,
  current: 100, tempThreshold: 65, baselineMa: 100, cleaning: false,
  tiltAngle: 30, targetAngle: 30, motionPaused: false,
  rainProtection: 'idle', rainDryRemainingS: 0 });

test('actuator UI has no invented angle or controls before the first telemetry frame', () => {
  const state = actuatorState(null);
  assert.equal(state.angle, null); assert.equal(state.target, null);
  assert.equal(state.label, '等待设备');
  assert.ok(state.stowLock && state.shieldLock && state.angleLock && state.cleanLock);
});

test('dry actuator presets are available and angle direction follows telemetry, not a timer', () => {
  const state = actuatorState(fixture());
  assert.equal(state.stowLock, ''); assert.equal(state.shieldLock, '');
  assert.equal(state.cleanLock, ''); assert.equal(state.motion, '指令保持');
  const rising = actuatorState({ ...fixture(), tiltAngle: 40, targetAngle: 90 });
  assert.equal(rising.angle, 40); assert.equal(rising.target, 90); assert.equal(rising.motion, '角度递增');
  assert.equal(rising.cleanLock, '舵机调节中');
  assert.equal(actuatorState({ ...fixture(), tiltAngle: 40, targetAngle: 0 }).motion, '角度递减');
});

test('wet protection blocks stowing and cleaning but permits the safe 90-degree request', () => {
  const state = actuatorState({ ...fixture(), rain: 100, rainProtection: 'rain', targetAngle: 90 });
  assert.ok(state.stowLock && state.angleLock && state.cleanLock && state.autoLock);
  assert.equal(state.shieldLock, ''); assert.equal(state.label, '90° 挡雨');
  assert.equal(state.tone, 'protection');
});

test('dry recovery countdown is the exact device value and returning locks both presets', () => {
  const data = { ...fixture(), rainProtection: 'drying', rainDryRemainingS: 7 };
  assert.equal(actuatorState(data).label, '无雨确认 · 7 秒');
  assert.equal(actuatorState(data).label, '无雨确认 · 7 秒');
  assert.ok(actuatorState(data).stowLock);
  assert.equal(actuatorState(data).shieldLock, '');
  const returning = actuatorState({ ...data, rainProtection: 'returning', rainDryRemainingS: 0 });
  assert.equal(returning.label, '收起至 0°');
  assert.ok(returning.stowLock && returning.shieldLock && returning.cleanLock);
});

test('STOP remains a visible lock rather than an unrequested resume or angle change', () => {
  const state = actuatorState({ ...fixture(), motionPaused: true, tiltAngle: 45, targetAngle: 45 });
  assert.equal(state.label, '已停止 · 联动暂停'); assert.equal(state.motion, '已停止');
  assert.equal(state.angle, 45); assert.equal(state.target, 45);
  assert.ok(state.stowLock && state.shieldLock && state.angleLock && state.cleanLock && state.autoLock);
});

test('missing rain blocks motion, while missing temperature only blocks cleaning', () => {
  const missingRain = actuatorState({ ...fixture(), validFlags: 3, rain: null, rainProtection: 'unavailable' });
  assert.ok(missingRain.stowLock && missingRain.shieldLock && missingRain.cleanLock);
  assert.equal(missingRain.label, '雨滴输入无效'); assert.equal(missingRain.tone, 'fault');
  const missingTemp = actuatorState({ ...fixture(), validFlags: 5, panelTemp: null });
  assert.equal(missingTemp.stowLock, ''); assert.equal(missingTemp.shieldLock, '');
  assert.equal(missingTemp.cleanLock, '电流或温度无效');
});

test('old firmware retains manual-angle fallback but cannot claim protected shortcuts', () => {
  const data = fixture();
  delete data.motionPaused; delete data.rainProtection; delete data.rainDryRemainingS;
  for (const protocol of [2, 3]) {
    const state = actuatorState({ ...data, protocol });
    assert.equal(state.supported, false); assert.equal(state.label, '固件待升级');
    assert.equal(state.angleLock, ''); assert.equal(state.stowLock, '固件待升级');
    assert.equal(state.shieldLock, '固件待升级');
  }
});

test('cleaning readiness distinguishes baseline, current, temperature and active cleaner locks', () => {
  assert.equal(actuatorState({ ...fixture(), baselineMa: 0 }).autoLock, '基准未标定');
  assert.equal(actuatorState({ ...fixture(), baselineMa: 0 }).cleanLock, '');
  assert.equal(actuatorState({ ...fixture(), current: 20 }).baselineLock, '电流不足');
  assert.equal(actuatorState({ ...fixture(), panelTemp: 65 }).cleanLock, '温度超限');
  assert.equal(actuatorState({ ...fixture(), cleaning: true }).baselineLock, '清扫运行中');
});
