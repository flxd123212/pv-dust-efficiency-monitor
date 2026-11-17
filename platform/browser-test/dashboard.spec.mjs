import { test, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Hub } from '../server/hub.mjs';
import { Store } from '../server/store.mjs';
import { createWebServer } from '../server/http.mjs';
import jsQR from 'jsqr';
import { Simulator } from '../server/transport.mjs';

async function login(page, url = '/') {
  await page.goto(url);
  await page.locator('#password').fill('Browser-Test-Password-2026');
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#device-status')).toContainText('设备在线');
  await expect(page.locator('#simulation-banner')).toBeVisible();
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  for (const button of await page.locator('button:visible').all()) {
    expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBeTruthy();
  }
}

async function decodedAccess(page) {
  const pixels = await page.locator('#access-qr').evaluate(canvas => ({ width: canvas.width, height: canvas.height,
    pixels: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data) }));
  return jsQR(Uint8ClampedArray.from(pixels.pixels), pixels.width, pixels.height)?.data;
}

test('NTC panel estimate is separate from SHT20 ambient on desktop/phone, invalid/legacy/offline states stay honest', async ({ page, context }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const transport = new Simulator(); clearInterval(transport.timer); clearTimeout(transport.first);
  const hub = new Hub({ store: new Store(':memory:'), transport, simulation: true });
  transport.tick();
  const web = createWebServer({ hub, password: 'Browser-Test-Password-2026', dist: path.resolve('dist') });
  await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const timer = setInterval(() => transport.tick(), 250);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, `http://127.0.0.1:${web.server.address().port}`);
    await expect(page.locator('#metric-temp')).toHaveText('31');
    await expect(page.locator('#ntc-state')).toHaveText('27.4 °C');
    await expect(page.locator('#ntc-detail')).toHaveText('估算 · PA5 ADC 1940');
    Object.assign(transport.state, { ntcAdc: 1665, surfaceTemp: 33.6 }); transport.tick();
    await expect(page.locator('#ntc-state')).toHaveText('33.6 °C');
    await expect(page.locator('#metric-temp')).toHaveText('31');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
      for (const item of await page.locator('.extension-facts > div').all())
        expect(await item.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
      await page.locator('.extension-section').screenshot({ path: `test-results/ntc-temperature-${width}.png` });
    }
    Object.assign(transport.state, { ntcAdc: 129, ntcStatus: 'invalid', surfaceTemp: null }); transport.tick();
    await expect(page.locator('#ntc-state')).toHaveText('-- °C');
    await expect(page.locator('#ntc-detail')).toContainText('采样无效');
    await expect(page.locator('#metric-temp')).toHaveText('31');
    transport.state.ntcStatus = 'unconfigured'; delete transport.state.surfaceTemp; transport.tick();
    await expect(page.locator('#ntc-state')).toHaveText('-- °C');
    await expect(page.locator('#ntc-detail')).toContainText('待更新固件');
    Object.assign(transport.state, { ntcAdc: 1940, ntcStatus: 'estimated', surfaceTemp: 27.4 }); transport.tick();
    await expect(page.locator('#ntc-state')).toHaveText('27.4 °C');
    await context.setOffline(true);
    await expect(page.locator('#extension-freshness')).toContainText('最后上报');
    await expect(page.locator('#ntc-state')).toHaveText('27.4 °C');
    await expect(page.locator('#pir-alarm-toggle')).toBeDisabled();
    await context.setOffline(false);
    expect(errors).toEqual([]);
  } finally { clearInterval(timer); await web.close(); await hub.close(); hub.store.close(); }
});

test('PIR maintenance switch uses real roundtrip on desktop/phone without hiding activity or other alarms', async ({ page, context }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const transport = new Simulator(); clearInterval(transport.timer); clearTimeout(transport.first);
  const hub = new Hub({ store: new Store(':memory:'), transport, simulation: true });
  Object.assign(transport.state, { pirStatus: 'ok', personDetected: true, pirWarmupRemainingS: 0, baselineMa: 800 });
  transport.tick();
  const web = createWebServer({ hub, password: 'Browser-Test-Password-2026', dist: path.resolve('dist') });
  await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const timer = setInterval(() => transport.tick(), 250);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, `http://127.0.0.1:${web.server.address().port}`);
    await expect(page.locator('#pir-state')).toHaveText('检测到人体活动');
    await expect(page.locator('#alarm-title')).toContainText('人体活动报警');
    await expect(page.locator('#ld1-state')).toHaveText('报警闪烁');
    await expect(page.locator('#clean-toggle')).toBeEnabled();
    await page.locator('#clean-toggle').click();
    await expect(page.locator('#cleaning-state')).toHaveText('清扫中');
    await expect(page.locator('#pir-alarm-toggle')).toBeChecked();
    await page.locator('#pir-alarm-toggle').click();
    await expect(page.locator('#pir-alarm-toggle')).not.toBeChecked();
    await expect(page.locator('#pir-alarm-state')).toHaveText('维修关闭');
    await expect(page.locator('#pir-state')).toHaveText('检测到人体活动');
    await expect(page.locator('#alarm-title')).toHaveText('无活动报警');
    await expect(page.locator('#ld1-state')).toHaveText('清扫常亮');
    await expect(page.locator('#cleaning-state')).toHaveText('清扫中');
    await expect(page.locator('#recent-events')).toContainText('关闭人体报警（维修）');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
      for (const item of await page.locator('.extension-facts > div').all())
        expect(await item.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
      await page.locator('.extension-section').screenshot({ path: `test-results/pir-maintenance-${width}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#pir-alarm-toggle').click();
    await expect(page.locator('#pir-alarm-toggle')).toBeChecked();
    await expect(page.locator('#alarm-title')).toContainText('人体活动报警');
    await page.locator('#pir-alarm-toggle').click();
    await expect(page.locator('#pir-alarm-state')).toHaveText('维修关闭');
    transport.state.rain = 100; transport.tick();
    await expect(page.locator('#alarm-title')).toHaveText('雨天保护');
    await expect(page.locator('#ld1-state')).toHaveText('报警闪烁');
    await expect(page.locator('#servo-target')).toHaveText('90°');
    await expect(page.locator('#pir-state')).toHaveText('检测到人体活动');
    await context.setOffline(true);
    await expect(page.locator('#pir-alarm-toggle')).toBeDisabled();
    await expect(page.locator('#extension-freshness')).toContainText('最后上报');
    await context.setOffline(false);
    expect(errors).toEqual([]);
  } finally { clearInterval(timer); await web.close(); await hub.close(); hub.store.close(); }
});

test('PIR switch waits for authoritative telemetry after ACK and distinguishes warmup, no activity, missing and legacy', async ({ page }) => {
  class Controlled extends EventEmitter {
    connected = true;
    sent = [];
    status() { return { connected: true, kind: 'test' }; }
    send(cmd) { this.sent.push(cmd); }
    reply() { this.emit('ack', { type: 'ack', cmdId: this.sent.at(-1).cmdId, accepted: true, applied: true, reason: 'OK' }); }
    async close() {}
  }
  const transport = new Controlled(), hub = new Hub({ store: new Store(':memory:'), transport, simulation: true });
  let seq = 0;
  let reading = { type: 'data', protocol: 3, current: 100, panelTemp: 25, rain: 0, dustLevel: null,
    tiltAngle: 0, targetAngle: 0, cleaning: false, mode: 'manual', alarm: 0, quality: 'uncalibrated', baselineMa: 0,
    dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10, autoCooldownS: 900,
    adcCurrent: 1250, adcVoltage: 1000, temperatureRaw: 26000, validFlags: 7, temperatureStatus: 'ok', saved: false,
    personDetected: null, pirStatus: 'warming', pirWarmupRemainingS: 60,
    ld1Mode: 'idle', ntcAdc: 2048, ntcStatus: 'unconfigured', pirAlarmEnabled: true };
  const emit = () => hub.ingest({ ...reading, seq: ++seq, uptimeS: seq });
  emit();
  const web = createWebServer({ hub, password: 'Browser-Test-Password-2026', dist: path.resolve('dist') });
  await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const timer = setInterval(emit, 250);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, `http://127.0.0.1:${web.server.address().port}`);
    await expect(page.locator('#pir-state')).toHaveText('预热中 · 60 秒');
    await expect(page.locator('#ntc-state')).toHaveText('-- °C');
    await expect(page.locator('#ntc-detail')).toContainText('待更新固件');
    await expect(page.locator('#ntc-detail')).toContainText('ADC 2048');
    reading = { ...reading, personDetected: true, pirStatus: 'ok', pirWarmupRemainingS: 0, alarm: 16, ld1Mode: 'alarm' }; emit();
    await expect(page.locator('#pir-state')).toHaveText('检测到人体活动');
    await page.locator('#pir-alarm-toggle').click();
    await expect.poll(() => transport.sent.length).toBe(1);
    expect(transport.sent[0].action).toBe('pirAlarm'); expect(transport.sent[0].value).toBe(0);
    await expect(page.locator('#pir-alarm-toggle')).toBeChecked();
    await expect(page.locator('#pir-alarm-toggle')).toBeDisabled();
    transport.reply();
    await expect(page.locator('#pir-alarm-toggle')).toBeEnabled();
    await expect(page.locator('#pir-alarm-toggle')).toBeChecked();
    await expect(page.locator('#pir-alarm-state')).toHaveText('已开启');
    reading = { ...reading, pirAlarmEnabled: false, alarm: 0, ld1Mode: 'idle' }; emit();
    await expect(page.locator('#pir-alarm-toggle')).not.toBeChecked();
    await expect(page.locator('#pir-alarm-state')).toHaveText('维修关闭');
    await expect(page.locator('#pir-state')).toHaveText('检测到人体活动');
    reading = { ...reading, personDetected: false }; emit();
    await expect(page.locator('#pir-state')).toHaveText('未检测到活动');
    reading = { ...reading, personDetected: null, pirStatus: 'unavailable', panelTemp: null, validFlags: 5, temperatureStatus: 'missing', alarm: 8, ld1Mode: 'alarm' }; emit();
    await expect(page.locator('#pir-state')).toHaveText('传感器不可用');
    await expect(page.locator('#metric-temp')).toHaveText('--');
    const old = { ...reading };
    for (const key of ['personDetected', 'pirStatus', 'pirWarmupRemainingS', 'ld1Mode', 'ntcAdc', 'ntcStatus', 'pirAlarmEnabled']) delete old[key];
    reading = old; emit();
    await expect(page.locator('#pir-state')).toHaveText('固件待升级');
    await expect(page.locator('#pir-alarm-toggle')).toBeDisabled();
  } finally { clearInterval(timer); await web.close(); await hub.close(); hub.store.close(); }
});

test('phone QR decodes to the selected address, updates with IP changes, downloads and handles offline', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let addresses = [
    { name: 'WLAN', url: 'http://10.52.47.218:8787/', scope: 'lan' },
    { name: 'Ethernet', url: 'http://172.16.1.5:8787/', scope: 'lan' }
  ];
  let failed = false;
  await page.clock.install();
  await page.route('**/api/access', route => failed ? route.abort() : route.fulfill({ json: { addresses, updatedAt: Date.now() } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.locator('#open-access').click();
  await expect(page.locator('#access-dialog')).toBeVisible();
  await expect(page.locator('#access-qr')).toBeVisible();
  await expect.poll(() => decodedAccess(page)).toBe(addresses[0].url);
  await expect(page.locator('#access-url')).toHaveAttribute('href', addresses[0].url);
  await expect(page.locator('#access-warning')).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: 'test-results/desktop-phone-qr.png' });
  await page.locator('#access-network').selectOption(addresses[1].url);
  await expect.poll(() => decodedAccess(page)).toBe(addresses[1].url);
  addresses = [{ name: 'WLAN', url: 'http://192.168.43.20:8787/', scope: 'lan' }];
  await page.clock.fastForward(15000);
  await expect(page.locator('#access-url')).toHaveText(addresses[0].url);
  await expect.poll(() => decodedAccess(page)).toBe(addresses[0].url);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    const bounds = await page.locator('#access-qr').boundingBox();
    expect(bounds.width).toBeGreaterThan(200);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    if (width === 390) await page.screenshot({ path: 'test-results/mobile-phone-qr.png' });
  }
  await page.locator('#copy-access').click();
  await expect(page.locator('#toast')).toContainText('已复制');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-access').click();
  expect((await downloadPromise).suggestedFilename()).toBe('pv-phone-access.png');
  failed = true;
  await page.locator('#refresh-access').click();
  await expect(page.locator('#access-empty')).toHaveText('无法读取网络地址');
  await expect(page.locator('#access-qr')).toBeHidden();
  await expect(page.locator('#access-url')).toBeHidden();
  await expect(page.locator('#download-access')).toBeDisabled();
  failed = false; addresses = [];
  await page.locator('#refresh-access').click();
  await expect(page.locator('#access-empty')).toHaveText('未发现可用的访问地址');
  await page.locator('#close-access').click();
  await expect(page.locator('#access-dialog')).toBeHidden();
  await page.locator('#logout').click();
  await expect(page.locator('#login')).toBeVisible();
  expect(errors).toEqual([]);
});

test('desktop live data, authoritative angle, rejection, calibration, persistence and audit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page.locator('#metric-current')).not.toHaveText('--');
  await expect.poll(() => page.locator('.panel-photo img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('#angle-range').evaluate(el => { el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#angle-output')).toHaveText('45°');
  await expect(page.locator('#target-angle')).toHaveText('0°');
  await page.locator('#angle-apply').click();
  await expect(page.locator('#target-angle')).toHaveText('45°');
  await expect(page.locator('#mode-auto')).toBeDisabled();
  const rejection = await page.request.post('/api/command', { data: { action: 'mode', value: 1 } });
  expect((await rejection.json()).reason).toBe('BASELINE_REQUIRED');
  await page.screenshot({ path: 'test-results/desktop-rejection.png', fullPage: true });
  await page.locator('[data-view=settings]').click();
  await page.locator('#calibrate-baseline').click();
  await page.locator('#confirm-dialog button[value=confirm]').click();
  await expect(page.locator('#baseline-value')).toContainText('mA');
  await page.locator('[name=cleanSeconds]').fill('3');
  await page.locator('#save-settings').click();
  await expect(page.locator('#saved-status')).toContainText('已写入');
  await page.locator('[data-view=overview]').click();
  await page.locator('#clean-toggle').click();
  await expect(page.locator('#cleaning-state')).toHaveText('清扫中');
  await expect(page.locator('#cleaning-state')).toHaveText('已停止', { timeout: 6000 });
  await expect(page.locator('#recent-events')).toContainText('已应用');
  await noOverflow(page);
  await page.screenshot({ path: 'test-results/desktop-overview.png', fullPage: true });
  await page.locator('[data-view=trends]').click();
  await expect(page.locator('#history-rows tr')).not.toHaveCount(0);
  await expect.poll(() => page.locator('#trend-chart').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0; for (let i = 0; i < data.length; i += 4) if (data[i+1] > data[i] + 20 && data[i+3] > 100) colored++;
    return colored;
  })).toBeGreaterThan(3);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-csv').click();
  expect((await downloadPromise).suggestedFilename()).toBe('pv-history.csv');
  await page.screenshot({ path: 'test-results/desktop-trends.png', fullPage: true });
  await page.locator('[data-view=events]').click();
  await expect(page.locator('#event-list')).toContainText('写入设备参数');
  expect(errors).toEqual([]);
});

test('mobile and tablet layouts, real controls and network loss lockout', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await noOverflow(page);
  await page.screenshot({ path: 'test-results/mobile-overview.png', fullPage: true });
  await page.locator('#safe-stop').click();
  await expect(page.locator('#toast')).toContainText('已应用');
  for (const width of [320, 390, 768, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['settings', 'trends', 'events', 'overview']) {
      await page.locator(`[data-view=${name}]`).click();
      await noOverflow(page);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-view=settings]').click();
  await page.screenshot({ path: 'test-results/mobile-settings.png', fullPage: true });
  await context.setOffline(true);
  await page.locator('[data-view=overview]').click();
  await expect(page.locator('#angle-apply')).toBeDisabled({ timeout: 8000 });
  await expect(page.locator('#safe-stop')).toBeDisabled();
  await expect(page.locator('#servo-stow')).toBeDisabled();
  await expect(page.locator('#servo-shield')).toBeDisabled();
  await expect(page.locator('#actuator-freshness')).toContainText('最后上报');
  await expect(page.locator('#offline-banner')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-disconnected.png', fullPage: true });
  await context.setOffline(false);
  await expect(page.locator('#resume-motion')).toBeEnabled({ timeout: 15000 });
  await page.locator('#resume-motion').click();
  await expect(page.locator('#angle-apply')).toBeEnabled({ timeout: 15000 });
  await page.locator('#logout').click();
  await expect(page.locator('#login')).toBeVisible();
});

test('online device with unplugged sensors, valid SHT20, and legacy ADC temperature are distinguished', async ({ page }) => {
  class FaultTransport extends EventEmitter {
    connected = true;
    status() { return { kind: 'test', connected: true }; }
    async close() {}
  }
  const hub = new Hub({ store: new Store(':memory:'), transport: new FaultTransport(), simulation: true });
  let seq = 0;
  let reading = { protocol: 3, current: null, panelTemp: null, rain: null, validFlags: 0, quality: 'invalid', temperatureStatus: 'missing' };
  const emit = () => hub.ingest({ type: 'data', seq: ++seq, uptimeS: seq, dustLevel: null,
    tiltAngle: 30, targetAngle: 30, cleaning: false, mode: 'manual', alarm: 8,
    baselineMa: 0, dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10, autoCooldownS: 900,
    adcCurrent: 1098, adcVoltage: 3072, temperatureRaw: 0, saved: false, ...reading });
  emit();
  const web = createWebServer({ hub, password: 'Browser-Test-Password-2026', dist: path.resolve('dist') });
  await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const timer = setInterval(emit, 250);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, `http://127.0.0.1:${web.server.address().port}`);
    await expect(page.locator('#metric-temp')).toHaveText('--');
    await expect(page.locator('#temp-caption')).toContainText('未连接');
    await expect(page.locator('#metric-current')).toHaveText('--');
    await expect(page.locator('#metric-rain')).toHaveText('--');
    await expect(page.locator('#angle-apply')).toBeEnabled();
    await expect(page.locator('#clean-toggle')).toBeDisabled();
    await expect(page.locator('#rain-automation')).toHaveText('固件待升级');
    await expect(page.locator('#resume-motion')).toBeHidden();
    await expect(page.locator('#servo-stow')).toBeDisabled();
    await expect(page.locator('#servo-shield')).toBeDisabled();
    await noOverflow(page);
    await page.screenshot({ path: 'test-results/mobile-sensors-unplugged.png', fullPage: true });
    reading = { protocol: 3, current: 88, panelTemp: 23.4, rain: null, validFlags: 3, quality: 'uncalibrated', temperatureStatus: 'ok' };
    await expect(page.locator('#metric-temp')).toHaveText('23.4');
    await expect(page.locator('#temp-caption')).toContainText('SHT20');
    await expect(page.locator('#metric-current')).toHaveText('88');
    await expect(page.locator('#metric-rain')).toHaveText('--');
    await expect(page.locator('#mode-auto')).toBeDisabled();
    reading = { protocol: 2, current: 281, panelTemp: 90, rain: 0, quality: 'uncalibrated', adcTemp: 3072 };
    await expect(page.locator('#temp-caption')).toContainText('旧版映射错误');
    await expect(page.locator('#metric-temp')).toHaveText('--');
    await expect(page.locator('#metric-current')).toHaveText('--');
    await expect(page.locator('#angle-apply')).toBeEnabled();
    await page.screenshot({ path: 'test-results/mobile-legacy-sensors.png', fullPage: true });
  } finally {
    clearInterval(timer);
    await web.close(); await hub.close(); hub.store.close();
  }
});

test('rain shield, drying countdown, STOP and resume are authoritative on phone and desktop', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const transport = new Simulator();
  clearInterval(transport.timer); clearTimeout(transport.first);
  const hub = new Hub({ store: new Store(':memory:'), transport, simulation: true });
  transport.tick();
  const web = createWebServer({ hub, password: 'Browser-Test-Password-2026', dist: path.resolve('dist') });
  await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const timer = setInterval(() => transport.tick(), 250);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, `http://127.0.0.1:${web.server.address().port}`);
    await expect(page.locator('#rain-automation')).toHaveText('待命');
    transport.state.rain = 100; transport.tick();
    await expect(page.locator('#rain-automation')).toHaveText('90° 挡雨');
    await expect(page.locator('#target-angle')).toHaveText('90°');
    await expect(page.locator('#servo-angle')).toHaveText('90°');
    await expect(page.locator('#servo-target')).toHaveText('90°');
    await expect(page.locator('#servo-stow')).toBeDisabled();
    await expect(page.locator('#servo-shield')).toBeEnabled();
    await expect(page.locator('#actuator-constraint')).toContainText('禁止收起');
    await expect(page.locator('#angle-apply')).toBeDisabled();
    await expect(page.locator('#clean-toggle')).toBeDisabled();
    await noOverflow(page);
    await page.screenshot({ path: 'test-results/mobile-rain-shield.png', fullPage: true });
    await page.locator('.actuator-section').screenshot({ path: 'test-results/mobile-actuator-controls.png' });
    transport.state.rain = 0; transport.tick();
    await expect(page.locator('#rain-automation')).toContainText('无雨确认');
    await page.locator('#safe-stop').click();
    await expect(page.locator('#rain-automation')).toHaveText('已停止 · 联动暂停');
    await expect(page.locator('#servo-stow')).toBeDisabled();
    await expect(page.locator('#servo-shield')).toBeDisabled();
    await expect(page.locator('#servo-motion')).toHaveText('已停止');
    transport.dryAt = Date.now() - 11000; transport.tick();
    await expect(page.locator('#target-angle')).toHaveText('90°');
    await expect(page.locator('#resume-motion')).toBeEnabled();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
    }
    await page.screenshot({ path: 'test-results/desktop-rain-paused.png', fullPage: true });
    await page.locator('.actuator-section').screenshot({ path: 'test-results/desktop-actuator-controls.png' });
    await page.locator('#resume-motion').click();
    await expect(page.locator('#rain-automation')).toHaveText('待命');
    await expect(page.locator('#target-angle')).toHaveText('0°');
    await expect(page.locator('#cleaning-state')).toHaveText('已停止');
    await expect(page.locator('#mode-state')).toHaveText('手动');
    await expect(page.locator('#resume-motion')).toBeHidden();
    await expect(page.locator('#angle-apply')).toBeEnabled();
    await expect(page.locator('#servo-stow')).toBeEnabled();
    await expect(page.locator('#servo-shield')).toBeEnabled();
    transport.state.rain = null; transport.state.validFlags = 3; transport.tick();
    await expect(page.locator('#rain-automation')).toHaveText('雨滴输入无效');
    await expect(page.locator('#angle-apply')).toBeDisabled();
    await expect(page.locator('#metric-rain')).toHaveText('--');
    expect(errors).toEqual([]);
  } finally {
    clearInterval(timer); await web.close(); await hub.close(); hub.store.close();
  }
});

test('named presets use real ACKs, never optimistic motion, and show rejection and returning locks', async ({ page }) => {
  class ControlledTransport extends EventEmitter {
    connected = true;
    sent = [];
    status() { return { kind: 'test', connected: true }; }
    send(cmd) { this.sent.push(cmd); }
    reply(applied, reason = 'OK') {
      const cmd = this.sent.at(-1);
      this.emit('ack', { type: 'ack', cmdId: cmd.cmdId, accepted: applied, applied, reason });
    }
    async close() {}
  }
  const transport = new ControlledTransport();
  const hub = new Hub({ store: new Store(':memory:'), transport, simulation: true });
  let seq = 0;
  let reading = { type: 'data', protocol: 3, tiltAngle: 30, targetAngle: 30, cleaning: false,
    mode: 'manual', current: 100, panelTemp: 25, rain: 0, dustLevel: null, alarm: 0,
    baselineMa: 0, dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10, autoCooldownS: 900,
    adcCurrent: 1250, adcVoltage: 1000, temperatureRaw: 26000, validFlags: 7,
    quality: 'uncalibrated', temperatureStatus: 'ok', saved: false,
    rainProtection: 'idle', rainDryRemainingS: 0, motionPaused: false };
  const emit = () => hub.ingest({ ...reading, seq: ++seq, uptimeS: seq });
  emit();
  const web = createWebServer({ hub, password: 'Browser-Test-Password-2026', dist: path.resolve('dist') });
  await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const timer = setInterval(emit, 250);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, `http://127.0.0.1:${web.server.address().port}`);
    await expect(page.locator('#servo-angle')).toHaveText('30°');
    await page.locator('#servo-shield').click();
    await expect.poll(() => transport.sent.length).toBe(1);
    expect(transport.sent[0].action).toBe('angle'); expect(transport.sent[0].value).toBe(90);
    await expect(page.locator('#servo-stow')).toBeDisabled();
    await expect(page.locator('#safe-stop')).toBeEnabled();
    await expect(page.locator('#servo-target')).toHaveText('30°');
    transport.reply(true);
    await expect(page.locator('#toast')).toContainText('挡雨至 90°');
    await expect(page.locator('#servo-angle')).toHaveText('30°');
    await expect(page.locator('#servo-target')).toHaveText('30°');
    reading = { ...reading, tiltAngle: 45, targetAngle: 90 }; emit();
    await expect(page.locator('#servo-angle')).toHaveText('45°');
    await expect(page.locator('#servo-target')).toHaveText('90°');
    await expect(page.locator('#servo-motion')).toHaveText('角度递增');
    await expect(page.locator('#servo-angle-meter')).toHaveJSProperty('value', 45);
    await expect(page.locator('#clean-toggle')).toBeDisabled();
    await page.locator('#servo-stow').click();
    await expect.poll(() => transport.sent.length).toBe(2);
    expect(transport.sent[1].value).toBe(0);
    transport.reply(false, 'RAIN_INTERLOCK');
    await expect(page.locator('#toast')).toContainText('禁止清扫及收起');
    await expect(page.locator('#servo-target')).toHaveText('90°');
    await expect(page.locator('#servo-angle')).toHaveText('45°');
    await expect(page.locator('#command-status')).toHaveClass(/error/);
    reading = { ...reading, tiltAngle: 90, targetAngle: 0, rainProtection: 'returning' }; emit();
    await expect(page.locator('#servo-motion')).toHaveText('角度递减');
    await expect(page.locator('#rain-automation')).toHaveText('收起至 0°');
    await expect(page.locator('#servo-stow')).toBeDisabled();
    await expect(page.locator('#servo-shield')).toBeDisabled();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      const cells = await page.locator('.actuator-facts > div').all();
      for (const cell of cells) expect(await cell.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    }
    reading = { ...reading, tiltAngle: 0, targetAngle: 0, rainProtection: 'idle' }; emit();
    await expect(page.locator('#servo-stow')).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#servo-stow').click();
    await expect.poll(() => transport.sent.length).toBe(3);
    transport.reply(true);
    await expect(page.locator('#toast')).toContainText('收起至 0°');
    await expect(page.locator('#recent-events')).toContainText('收起至 0°');
    await page.locator('[data-view=events]').click();
    await expect(page.locator('#event-list')).toContainText('挡雨至 90°');
  } finally {
    clearInterval(timer); await web.close(); await hub.close(); hub.store.close();
  }
});
