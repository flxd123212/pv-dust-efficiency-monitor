export function actuatorState(data) {
  if (!data) return {
    supported: false, paused: false, label: '等待设备', tone: 'neutral', motion: '--',
    angle: null, target: null, stowLock: '等待设备', shieldLock: '等待设备',
    angleLock: '等待设备', cleanLock: '等待设备', autoLock: '等待设备', baselineLock: '等待设备'
  };
  const supported = ['rainProtection', 'rainDryRemainingS', 'motionPaused'].every(key => Object.hasOwn(data, key));
  const paused = supported && data.motionPaused;
  const rainReady = data.protocol === 3 && Boolean(data.validFlags & 4) && data.rain !== null;
  const recovering = supported && ['drying', 'returning'].includes(data.rainProtection);
  const moving = data.tiltAngle !== data.targetAngle;
  const labels = { idle: '待命', rain: '90° 挡雨', drying: `无雨确认 · ${data.rainDryRemainingS} 秒`, returning: '收起至 0°', unavailable: '雨滴输入无效' };
  const baseLock = !supported ? '固件待升级' : paused ? '动作已停止' : !rainReady ? '雨滴输入无效' : '';
  const stowLock = baseLock || (data.rain ? '雨天保护 · 禁止收起' : recovering ? '雨后保护 · 等待收起完成' : '');
  const shieldLock = baseLock || (data.rainProtection === 'returning' ? '雨后收起中' : '');
  const angleLock = supported ? stowLock : '';
  const cleanLock = paused ? '动作已停止' : data.protocol < 3 ? '固件待升级' : (data.validFlags & 3) !== 3 ? '电流或温度无效'
    : !rainReady ? '雨滴输入无效' : data.rain ? '雨天保护' : recovering ? '雨后保护'
    : data.panelTemp >= data.tempThreshold ? '温度超限' : moving ? '舵机调节中' : '';
  return {
    supported, paused, label: !supported ? '固件待升级' : paused ? '已停止 · 联动暂停' : labels[data.rainProtection],
    tone: !supported || !rainReady ? 'fault' : paused ? 'paused' : data.rain || recovering ? 'protection' : 'ready',
    motion: paused ? '已停止' : !moving ? '指令保持' : data.tiltAngle < data.targetAngle ? '角度递增' : '角度递减',
    angle: data.tiltAngle, target: data.targetAngle, stowLock, shieldLock, angleLock, cleanLock,
    autoLock: cleanLock || (data.baselineMa < 50 ? '基准未标定' : ''),
    baselineLock: data.cleaning ? '清扫运行中' : cleanLock || (data.current < 50 ? '电流不足' : '')
  };
}
