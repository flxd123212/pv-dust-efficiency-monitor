export function extensionState(data) {
  const keys = ['personDetected', 'pirStatus', 'pirWarmupRemainingS', 'ld1Mode', 'ntcAdc', 'ntcStatus', 'pirAlarmEnabled'];
  if (!data || data.protocol !== 3 || !keys.every(key => Object.hasOwn(data, key))) return {
    pir: data ? '固件待升级' : '等待设备', pirDetail: 'PB4 · RDA226', tone: 'neutral',
    led: '--', ntc: data ? '未启用' : '等待设备', ntcDetail: 'PA5 · ADC --', supported: false, enabled: true
  };
  const pir = data.pirStatus === 'warming' ? `预热中 · ${data.pirWarmupRemainingS} 秒`
    : data.pirStatus !== 'ok' ? '传感器不可用' : data.personDetected ? '检测到人体活动' : '未检测到活动';
  return {
    pir, pirDetail: 'PB4 · RDA226', tone: data.pirStatus !== 'ok' ? 'pending' : !data.pirAlarmEnabled ? 'maintenance' : data.personDetected ? 'alarm' : 'ready',
    led: { alarm: '报警闪烁', cleaning: '清扫常亮', paused: '停止慢闪', idle: '熄灭' }[data.ld1Mode],
    ntc: data.ntcStatus === 'estimated' && Number.isFinite(data.surfaceTemp) ? `${data.surfaceTemp.toFixed(1)} °C` : '-- °C',
    ntcDetail: data.ntcStatus === 'unconfigured' ? `待更新固件 · ADC ${data.ntcAdc ?? '--'}`
      : `${data.ntcStatus === 'estimated' ? '估算' : '采样无效'} · PA5 ADC ${data.ntcAdc ?? '--'}`,
    supported: true, enabled: data.pirAlarmEnabled
  };
}
