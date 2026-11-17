import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulator } from '../server/transport.mjs';
import { validateData } from '../server/contract.mjs';
import { extensionState } from '../web/src/extension-state.js';
import { oneNetProperties } from '../server/onenet.mjs';

function fixture() {
  const simulation = new Simulator();
  clearInterval(simulation.timer); clearTimeout(simulation.first);
  return { ...simulation.state, seq: 1, pirStatus: 'ok', pirWarmupRemainingS: 0, personDetected: false };
}
test('NTC conversion capability is atomic, typed, range checked and compatible with raw-only firmware', () => {
  const data = fixture();
  assert.ok(validateData(data));
  for (const change of [{ surfaceTemp: null }, { surfaceTemp: '27.4' }, { surfaceTemp: true },
    { surfaceTemp: 19.9 }, { surfaceTemp: 80.1 }, { surfaceTemp: NaN }, { ntcAdc: null },
    { ntcAdc: 0 }, { ntcAdc: 4095 }, { ntcStatus: 'invalid' }, { ntcStatus: 'unconfigured' }])
    assert.equal(validateData({ ...data, ...change }), null, JSON.stringify(change));
  assert.ok(validateData({ ...data, surfaceTemp: 20 }));
  assert.ok(validateData({ ...data, surfaceTemp: 80 }));
  assert.ok(validateData({ ...data, ntcStatus: 'invalid', ntcAdc: null, surfaceTemp: null }));
  assert.ok(validateData({ ...data, ntcStatus: 'invalid', ntcAdc: 129, surfaceTemp: null }));
  const missing = { ...data }; delete missing.surfaceTemp;
  assert.equal(validateData(missing), null);
  assert.ok(validateData({ ...missing, ntcStatus: 'unconfigured' }));
  const legacy = validateData({ ...data, protocol: 2 });
  assert.equal(Object.hasOwn(legacy, 'surfaceTemp'), false);
});
test('ambient and estimated panel temperature stay distinct; missing values and true/false PIR map honestly', () => {
  const data = fixture();
  const props = oneNetProperties(data, 1000, 1000);
  assert.equal(props.surfaceTemp, 27.4); assert.equal(props.panelTemp, 31);
  assert.equal(props.personDetected, false);
  assert.equal(extensionState(data).ntc, '27.4 °C');
  assert.match(extensionState(data).ntcDetail, /估算/);
  const warming = { ...data, pirStatus: 'warming', pirWarmupRemainingS: 60, personDetected: null };
  assert.equal(Object.hasOwn(oneNetProperties(warming, 1000, 1000), 'personDetected'), false);
  const invalid = { ...data, surfaceTemp: null, ntcStatus: 'invalid', ntcAdc: 129 };
  assert.equal(Object.hasOwn(oneNetProperties(invalid, 1000, 1000), 'surfaceTemp'), false);
  assert.equal(extensionState(invalid).ntc, '-- °C'); assert.match(extensionState(invalid).ntcDetail, /采样无效/);
  assert.deepEqual(oneNetProperties(data, 1000, 6000), {});
  const noAmbient = { ...data, panelTemp: null, current: null, validFlags: 4, quality: 'invalid', temperatureStatus: 'missing', pirStatus: 'unavailable', personDetected: null };
  assert.ok(validateData(noAmbient));
  const independent = oneNetProperties(noAmbient, 1000, 1000);
  assert.equal(independent.surfaceTemp, 27.4); assert.equal(Object.hasOwn(independent, 'panelTemp'), false);
});
