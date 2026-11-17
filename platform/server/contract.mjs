export const DEVICE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const ID_PATTERN = /^[a-f0-9]{32}$/;
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
export function validateCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_COMMAND');
  const { action } = input;
  const ranges = { angle: [0, 90], clean: [0, 1], mode: [0, 1], silence: [1, 1], stop: [1, 1], resume: [1, 1], pirAlarm: [0, 1], baseline: [1, 1], save: [1, 1] };
  if (action === 'settings') {
    const limits = { dustThreshold: [10, 90], tempThreshold: [35, 90], cleanSeconds: [3, 30], autoCooldownS: [60, 3600] };
    const out = { action };
    for (const [key, [min, max]] of Object.entries(limits)) {
      if (!integer(input[key], min, max)) throw new Error('OUT_OF_RANGE');
      out[key] = input[key];
    }
    if (Object.keys(input).some(k => k !== 'action' && !Object.hasOwn(limits, k))) throw new Error('INVALID_COMMAND');
    return out;
  }
  if (!Object.hasOwn(ranges, action)) throw new Error('INVALID_COMMAND');
  if (!integer(input.value, ...ranges[action])) throw new Error('OUT_OF_RANGE');
  if (Object.keys(input).some(k => k !== 'action' && k !== 'value')) throw new Error('INVALID_COMMAND');
  return { action, value: input.value };
}

export function validateData(input) {
  if (!input || input.type !== 'data' || ![2, 3].includes(input.protocol)) return null;
  const bounds = {
    seq: [0, 4294967295], uptimeS: [0, 4294967], tiltAngle: [0, 90], targetAngle: [0, 90], alarm: [0, 31],
    baselineMa: [0, 2000], dustThreshold: [10, 90], tempThreshold: [35, 90], cleanSeconds: [3, 30],
    autoCooldownS: [60, 3600], adcCurrent: [0, 4095]
  };
  if (!['manual', 'auto'].includes(input.mode) || !['estimated', 'uncalibrated', 'low_current', 'invalid'].includes(input.quality)) return null;
  if (typeof input.cleaning !== 'boolean' || typeof input.saved !== 'boolean') return null;
  for (const [key, range] of Object.entries(bounds)) if (!integer(input[key], ...range)) return null;
  if (input.protocol === 2) {
    const { rainProtection, rainDryRemainingS, motionPaused, personDetected, pirStatus,
      pirWarmupRemainingS, ld1Mode, ntcAdc, ntcStatus, surfaceTemp, pirAlarmEnabled, ...legacy } = input;
    if (input.alarm > 15) return null;
    return { ...legacy, current: null, panelTemp: null, rain: null, dustLevel: null,
      quality: 'invalid', validFlags: 0, temperatureStatus: 'legacy' };
  }
  if (!integer(input.validFlags, 0, 7) || !integer(input.adcVoltage, 0, 4095) || !integer(input.temperatureRaw, 0, 65535)) return null;
  if (!['pending', 'ok', 'missing', 'crc', 'timeout'].includes(input.temperatureStatus)) return null;
  if (input.validFlags & 1 ? !integer(input.current, 0, 2000) : input.current !== null) return null;
  if (input.validFlags & 2 ? !(Number.isFinite(input.panelTemp) && input.panelTemp >= -40 && input.panelTemp <= 125 && input.temperatureStatus === 'ok') : input.panelTemp !== null || input.temperatureStatus === 'ok') return null;
  if (input.validFlags & 4 ? ![0, 100].includes(input.rain) : input.rain !== null) return null;
  if (input.quality === 'estimated' ? (input.validFlags & 3) !== 3 || !integer(input.dustLevel, 0, 100) : input.dustLevel !== null) return null;
  const automationKeys = ['rainProtection', 'rainDryRemainingS', 'motionPaused'];
  if (automationKeys.some(key => Object.hasOwn(input, key))) {
    if (!automationKeys.every(key => Object.hasOwn(input, key)) ||
        !['idle', 'rain', 'drying', 'returning', 'unavailable'].includes(input.rainProtection) ||
        !integer(input.rainDryRemainingS, 0, 10) || typeof input.motionPaused !== 'boolean') return null;
    if (input.rainProtection !== 'drying' && input.rainDryRemainingS !== 0) return null;
    if (Boolean(input.validFlags & 4) === (input.rainProtection === 'unavailable')) return null;
    if ((input.validFlags & 4) && (input.rain === 100) !== (input.rainProtection === 'rain')) return null;
    if ((input.motionPaused || ['rain', 'drying', 'returning'].includes(input.rainProtection)) &&
        (input.cleaning || input.mode !== 'manual')) return null;
    if (input.motionPaused && input.targetAngle !== input.tiltAngle) return null;
  }
  const extensionKeys = ['personDetected', 'pirStatus', 'pirWarmupRemainingS', 'ld1Mode', 'ntcAdc', 'ntcStatus', 'pirAlarmEnabled'];
  if (extensionKeys.some(key => Object.hasOwn(input, key))) {
    if (!extensionKeys.every(key => Object.hasOwn(input, key)) ||
        !['warming', 'ok', 'unavailable'].includes(input.pirStatus) ||
        !integer(input.pirWarmupRemainingS, 0, 60) || typeof input.pirAlarmEnabled !== 'boolean' || !['unconfigured', 'estimated', 'invalid'].includes(input.ntcStatus) ||
        (input.ntcAdc !== null && !integer(input.ntcAdc, 0, 4095))) return null;
    if (input.ntcStatus === 'unconfigured' ? Object.hasOwn(input, 'surfaceTemp') : !Object.hasOwn(input, 'surfaceTemp')) return null;
    if (input.ntcStatus === 'estimated' && !(Number.isFinite(input.surfaceTemp) && input.surfaceTemp >= 20 && input.surfaceTemp <= 80 && integer(input.ntcAdc, 1, 4094))) return null;
    if (input.ntcStatus === 'invalid' && input.surfaceTemp !== null) return null;
    if (input.pirStatus === 'ok' ? typeof input.personDetected !== 'boolean' : input.personDetected !== null) return null;
    if (input.pirStatus === 'warming' ? input.pirWarmupRemainingS < 1 : input.pirWarmupRemainingS !== 0) return null;
    if (!(input.validFlags & 2) && input.pirStatus !== 'unavailable') return null;
    if (Boolean(input.alarm & 16) !== (input.personDetected === true && input.pirAlarmEnabled)) return null;
    const ledMode = input.alarm ? 'alarm' : input.cleaning ? 'cleaning' : input.motionPaused ? 'paused' : 'idle';
    if (input.ld1Mode !== ledMode) return null;
  } else if ((input.alarm & 16) || Object.hasOwn(input, 'surfaceTemp')) return null;
  return { ...input };
}

export function validateAck(input) {
  return input?.type === 'ack' && ID_PATTERN.test(input.cmdId) && typeof input.accepted === 'boolean' &&
    typeof input.applied === 'boolean' && (!input.applied || input.accepted) &&
    typeof input.reason === 'string' && /^[A-Z_]{1,48}$/.test(input.reason);
}
export const rejection = (cmdId, reason) => ({ type: 'ack', cmdId, accepted: false, applied: false, reason });
