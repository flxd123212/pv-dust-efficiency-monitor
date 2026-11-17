import './style.css';
import Chart from 'chart.js/auto';
import QRCode from 'qrcode';
import { actuatorState } from './actuator-state.js';
import { extensionState } from './extension-state.js';
import { createIcons, Sun, ArrowRight, LayoutDashboard, ChartNoAxesCombined, ListChecks, Settings2,
  Usb, Cloud, LogOut, FlaskConical, Unplug, Zap, Thermometer, Layers, CloudRain, MoveUpRight,
  SlidersHorizontal, Minus, Plus, Check, Brush, ShieldCheck, BellOff, OctagonPause, Download,
  RotateCw, Save, Crosshair, Info, Network, Plug, X, Clock, QrCode, Copy, ArrowDownToLine, UserRound, Lightbulb } from 'lucide';
const icons = { Sun, ArrowRight, LayoutDashboard, ChartNoAxesCombined, ListChecks, Settings2, Usb,
  Cloud, LogOut, FlaskConical, Unplug, Zap, Thermometer, Layers, CloudRain, MoveUpRight,
  SlidersHorizontal, Minus, Plus, Check, BrushCleaning: Brush, ShieldCheck, BellOff, OctagonPause,
  Download, RotateCw, Save, Crosshair, Info, Network, Plug, X, Clock, QrCode, Copy, ArrowDownToLine, UserRound, Lightbulb };
const refreshIcons = () => createIcons({ icons, attrs: { 'stroke-width': 1.7 } });
const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const time = at => at ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(at) : '--';
const dateTime = at => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(at);
const duration = seconds => `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
const reasons = {
  MOTION_PAUSED: '动作已停止，需先恢复联动', RAIN_RECOVERY: '雨后收起保护，暂不允许启动',
  OK: '设备已应用', DEVICE_OFFLINE: '设备离线', NO_ACK_TIMEOUT: '未收到设备回执',
  OUT_OF_RANGE: '参数超出范围', RAIN_INTERLOCK: '雨天保护，禁止清扫及收起', TEMP_INTERLOCK: '温度保护，清扫已锁定',
  SENSOR_FAULT: '采样异常，清扫已锁定', BASELINE_REQUIRED: '清洁电流基准尚未标定', LOW_CURRENT: '当前电流不足，无法标定',
  RAIN_UNAVAILABLE: '雨滴输入无效，保护动作已锁定', FIRMWARE_UPDATE_REQUIRED: '当前固件不支持，请烧录新版固件',
  BUSY: '设备正忙', SAVE_FAILED: '设备保存失败', INVALID_COMMAND: '命令格式错误',
  TRANSPORT_ERROR: '通信发送失败', ID_CONFLICT: '命令编号冲突', INVALID_PASSWORD: '访问密码不正确',
  AUTH_REQUIRED: '登录已失效', RATE_LIMITED: '操作过于频繁', PORT_NOT_FOUND: '串口不存在，请刷新',
  DEVICE_REBOOTED: '设备已重新启动', CONNECTION_CHANGED: '连接已切换', SERVER_RESTARTED: '服务已重启',
  STALE_COMMAND: '命令已过期', NOT_SERIAL_GATEWAY: '当前不是串口网关', INVALID_REQUEST: '请求无法处理',
  RESULT_UNKNOWN: '连接中断，执行结果未知'
};
const actionNames = { angle: '设置倾角', clean: '组件清扫', mode: '运行模式', silence: '报警静音', stop: '停止所有动作', resume: '恢复联动', baseline: '标定清洁基准', settings: '应用运行参数', save: '写入设备参数' };
let snapshot = null, feedUp = false, source = null, reconnect = null, backoff = 1000;
let view = 'overview', busy = 0, angleDirty = false, settingsDirty = false;
let overviewHistory = [], history = [], logs = [], hours = 1, toastTimer;
let overviewChart, trendChart;
let lastCommand = null;
let lastFrameMono = -Infinity;
let accessAddresses = [], accessTimer, accessRequest = 0, accessDrawing = 0;
const settingsKeys = ['dustThreshold', 'tempThreshold', 'cleanSeconds', 'autoCooldownS'];
const sensorStatuses = { pending: '等待温度采样', ok: 'SHT20 实测环境温度', missing: '温湿度传感器未连接', crc: '温度校验失败', timeout: '温度采样超时', legacy: '旧版映射错误，需更新固件' };
function observed(row, key) {
  const flag = { current: 1, panelTemp: 2, rain: 4, dustLevel: 1 }[key];
  if (flag && (row.protocol !== 3 || !(row.validFlags & flag) || (key === 'dustLevel' && row.quality !== 'estimated'))) return null;
  return Number.isFinite(row[key]) ? row[key] : null;
}

async function api(route, options = {}) {
  const response = await fetch(route, { signal: AbortSignal.timeout(10000), ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (response.status === 401 && route !== '/api/login') showLogin();
  if (!response.ok && data.type !== 'ack') throw new Error(data.error || 'NETWORK_ERROR');
  return data;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  text('toast', message);
  $('toast').className = `toast${error ? ' error' : ''}`;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function reportError(error) { toast(reasons[error.message] || '连接失败，请检查服务状态', true); }
function isLive() { return Boolean(navigator.onLine && snapshot?.online && feedUp && performance.now() - lastFrameMono < 5000); }
function showLogin() {
  if ($('access-dialog').open) $('access-dialog').close();
  source?.close(); source = null;
  clearTimeout(reconnect);
  feedUp = false;
  $('app').hidden = true;
  $('login').hidden = false;
}
function setView(next) {
  view = next;
  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === view);
    button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false');
  }
  for (const item of document.querySelectorAll('.view')) item.hidden = item.id !== 'view-' + view;
  text('view-label', { overview: '总览', trends: '数据趋势', events: '操作记录', settings: '设备设置' }[view]);
  if (view === 'trends') { loadHistory().catch(reportError); requestAnimationFrame(() => trendChart?.resize()); }
  if (view === 'events') loadLogs().catch(reportError);
  if (view === 'settings') loadPorts().catch(reportError);
  if (view === 'overview') requestAnimationFrame(() => overviewChart?.resize());
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.querySelector('.workspace').scrollTo({ top: 0, behavior: 'instant' });
}
function renderActuator(d, live) {
  const state = actuatorState(d);
  const lock = (id, reason, title) => {
    const unavailable = !live ? '设备离线' : busy > 0 ? '等待设备回执' : reason;
    $(id).disabled = Boolean(unavailable);
    $(id).title = unavailable || title;
  };
  text('rain-automation', state.label);
  $('rain-automation').dataset.tone = state.tone;
  text('actuator-freshness', !d ? '等待设备' : live ? '实时上报' : '离线 · 最后上报');
  text('servo-angle', state.angle === null ? '--' : `${state.angle}°`);
  text('servo-target', state.target === null ? '--' : `${state.target}°`);
  text('servo-motion', state.motion);
  $('servo-angle-meter').hidden = state.angle === null;
  if (state.angle !== null) $('servo-angle-meter').value = state.angle;
  text('actuator-constraint', !live ? d ? '设备离线 · 控制锁定' : '等待设备' : busy ? '等待设备回执'
    : state.stowLock || (state.angle !== state.target ? '舵机调节中' : '舵机指令保持'));
  lock('servo-stow', state.stowLock, '收起至 0 度');
  lock('servo-shield', state.shieldLock, '挡雨至 90 度');
  $('resume-motion').hidden = !state.paused;
  lock('resume-motion', !state.supported ? '固件待升级' : !(d.validFlags & 4) ? '雨滴输入无效' : '', '恢复联动');
  for (const id of ['angle-range', 'angle-minus', 'angle-plus', 'angle-apply'])
    lock(id, state.angleLock, { 'angle-range': '目标倾角', 'angle-minus': '降低 5 度', 'angle-plus': '升高 5 度', 'angle-apply': '设置倾角' }[id]);
  lock('clean-toggle', d?.cleaning ? '' : state.cleanLock, d?.cleaning ? '停止清扫' : '启动清扫');
  lock('mode-auto', state.autoLock, '自动清扫');
  lock('calibrate-baseline', state.baselineLock, '标定清洁电流基准');
  text('clean-constraint', !live ? '设备离线 · 清扫控制锁定' : state.cleanLock ? `${state.cleanLock} · 清扫锁定`
    : state.autoLock ? `${state.autoLock} · 自动清扫锁定` : d?.cleaning ? '定时清扫运行中' : '清扫就绪');
}
function renderState() {
  if (!snapshot) return;
  const d = snapshot.data, live = isLive(), cloud = snapshot.connection.cloud || {};
  const cloudLabel = cloud.error ? '连接异常' : !cloud.connected ? (cloud.configured ? '连接中断' : '未配置')
    : cloud.reportError ? '上报异常' : cloud.extensionReportError ? '新增属性未确认' : cloud.provider === 'onenet' ? (cloud.lastReportAt ? '上报已确认' : '已连接·待数据') : '已连接';
  text('device-id', snapshot.deviceId);
  text('setting-device-id', snapshot.deviceId);
  $('device-status').classList.toggle('offline', !live);
  $('device-status').lastElementChild.textContent = live ? '设备在线' : '设备离线';
  text('last-update', snapshot.receivedAt ? `更新于 ${time(snapshot.receivedAt)}` : '尚未接收数据');
  $('simulation-banner').hidden = !snapshot.simulation;
  $('offline-banner').hidden = live;
  text('offline-message', !feedUp ? '实时连接中断，控制已锁定' : d ? '设备离线，当前为最后上报值' : '设备离线，控制已锁定');
  text('cloud-status', (cloud.provider === 'onenet' ? 'OneNET ' : '云端') + cloudLabel);
  text('setting-cloud', cloudLabel + (cloud.lastPostCode && cloud.lastPostCode !== 200 ? ' (' + cloud.lastPostCode + ')' : ''));
  text('setting-cloud-report', cloud.lastReportAt ? new Date(cloud.lastReportAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '--');
  text('setting-cloud-fields', cloud.lastReportFields?.join(', ') || '--');
  text('link-kind', snapshot.simulation ? '模拟联调' : snapshot.role === 'cloud' ? '云端服务' : 'USB 串口网关');
  text('setting-link', snapshot.connection.connected ? (snapshot.connection.port || (snapshot.simulation ? '模拟联调' : 'MQTT')) : (snapshot.connection.error === 'SERIAL_OPEN_FAILED' ? '串口打开失败' : '未连接'));
  text('footer-source', snapshot.simulation ? 'SIMULATION / 非真实设备数据' : !d ? '等待设备数据' : !live ? '最后上报值 / 当前离线' : snapshot.role === 'cloud' ? 'MQTT / 设备上报' : 'USB SERIAL / 设备上报');
  text('component-status', live ? '实时上报' : '等待连接');
  const serialAvailable = snapshot.role === 'gateway' && !snapshot.simulation;
  for (const id of ['serial-port', 'refresh-ports', 'connect-port', 'disconnect-port']) $(id).disabled = !serialAvailable;
  $('open-connection').hidden = !serialAvailable;
  for (const item of document.querySelectorAll('[data-control]')) item.disabled = !live || busy > 0;
  $('safe-stop').disabled = !live;
  renderActuator(d, live);
  const extension = extensionState(d);
  text('extension-freshness', !d ? '等待设备' : live ? '实时上报' : '离线 · 最后上报');
  text('pir-state', extension.pir);
  $('pir-state').dataset.tone = extension.tone;
  text('pir-detail', extension.pirDetail);
  text('ld1-state', extension.led);
  text('ntc-state', extension.ntc);
  text('ntc-detail', extension.ntcDetail);
  $('pir-alarm-toggle').checked = extension.supported && extension.enabled;
  $('pir-alarm-toggle').disabled = !live || busy > 0 || !extension.supported;
  text('pir-alarm-state', !extension.supported ? d ? '固件待升级' : '等待设备' : extension.enabled ? '已开启' : '维修关闭');
  $('pir-alarm-state').dataset.disabled = String(extension.supported && !extension.enabled);
  if (d) {
    text('metric-current', observed(d, 'current') ?? '--');
    text('metric-temp', observed(d, 'panelTemp') ?? '--');
    text('metric-dust', observed(d, 'dustLevel') ?? '--');
    text('metric-rain', observed(d, 'rain') === null ? '--' : d.rain ? '有雨' : '干燥');
    text('current-caption', d.protocol < 3 ? '旧版映射错误，需更新固件' : observed(d, 'current') !== null ? `采样电流 · ADC ${d.adcCurrent}` : '扩展板未确认或电流采样异常');
    text('temp-caption', sensorStatuses[d.temperatureStatus] || '温度采样无效');
    text('dust-caption', d.quality === 'uncalibrated' ? '基准未标定' : d.quality === 'low_current' ? '电流不足，待判定' : d.quality === 'invalid' ? '采样异常' : `清洁基准 ${d.baselineMa} mA`);
    text('rain-caption', observed(d, 'rain') === null ? '雨滴传感器未确认接入' : d.rain ? '雨天保护生效' : '未检测到雨滴');
    const sensorsReady = d.protocol === 3 && d.validFlags === 7;
    text('component-status', d.protocol < 3 ? '采集固件待更新' : (d.validFlags & 2) ? '传感器在线' : '温湿度未连接 / 无效');
    text('panel-angle', d.tiltAngle);
    text('target-angle', `${d.targetAngle}°`);
    text('cleaning-state', d.cleaning ? '清扫中' : '已停止');
    text('uptime', duration(d.uptimeS));
    text('setting-uptime', duration(d.uptimeS));
    text('mode-caption', d.mode === 'auto' ? '自动清扫模式' : '手动模式');
    text('mode-state', d.mode === 'auto' ? '自动' : '手动');
    $('mode-manual').classList.toggle('active', d.mode === 'manual');
    $('mode-auto').classList.toggle('active', d.mode === 'auto');
    $('mode-manual').setAttribute('aria-pressed', String(d.mode === 'manual'));
    $('mode-auto').setAttribute('aria-pressed', String(d.mode === 'auto'));
    if (!angleDirty) { $('angle-range').value = d.targetAngle; text('angle-output', `${d.targetAngle}°`); }
    text('clean-limit', `${d.cleanSeconds} 秒上限`);
    text('clean-button-text', d.cleaning ? '停止清扫' : '启动清扫');
    const alarms = [[8, '采样异常'], [2, '温度超限'], [4, '雨天保护'], [16, '人体活动报警'], [1, '积灰估计超限']].filter(([bit]) => d.alarm & bit).map(([, label]) => label);
    text('alarm-title', alarms.length ? alarms.join(' · ') : '无活动报警');
    text('alarm-detail', !sensorsReady ? '传感器未就绪，清扫已锁定' : d.alarm & 14 ? '清扫输出受本地保护限制' : d.alarm & 16 ? '检测到人体活动' : d.cleaning ? '定时清扫运行中' : '设备保护就绪');
    $('alarm-state').classList.toggle('active', alarms.length > 0);
    text('saved-status', d.saved ? '参数已写入设备' : '设备参数未保存');
    text('baseline-value', d.baselineMa ? `${d.baselineMa} mA` : '未标定');
    text('setting-quality', ({ estimated: '相对估计', uncalibrated: '基准未标定', low_current: '电流不足', invalid: '采样异常' })[d.quality] || '--');
    text('setting-adc', `${d.adcCurrent} / ${d.adcVoltage ?? d.adcTemp ?? '--'}`);
    if (!settingsDirty) for (const key of settingsKeys) $('settings-form').elements[key].value = d[key];
  } else {
    for (const id of ['metric-current', 'metric-temp', 'metric-dust', 'metric-rain', 'panel-angle', 'target-angle', 'cleaning-state', 'uptime', 'setting-uptime', 'setting-quality']) text(id, '--');
    for (const id of ['current-caption', 'rain-caption']) text(id, '等待采样');
    text('dust-caption', '等待设备'); text('temp-caption', '等待 SHT20'); text('saved-status', '等待设备');
    text('mode-caption', '等待设备'); text('mode-state', '--'); text('baseline-value', '-- mA'); text('setting-adc', '-- / --');
    text('alarm-title', '等待设备'); text('alarm-detail', '尚未接收数据');
    $('alarm-state').classList.remove('active');
    if (!settingsDirty) for (const key of settingsKeys) $('settings-form').elements[key].value = '';
  }
  const commandStatus = $('command-status');
  commandStatus.className = `command-status${lastCommand ? lastCommand.applied ? ' success' : ' error' : ''}`;
  commandStatus.lastElementChild.textContent = busy ? '正在等待设备回执…' : lastCommand ? `${time(lastCommand.at)} · ${reasons[lastCommand.reason] || lastCommand.reason}` : live ? '设备已连接' : '等待设备连接';
}
function receiveState(next, isData = false) {
  if (next.receivedAt && next.receivedAt !== snapshot?.receivedAt) lastFrameMono = performance.now();
  snapshot = next;
  renderState();
  if (isData && next.data) {
    const point = { at: next.receivedAt, ...next.data };
    overviewHistory.push(point);
    overviewHistory = overviewHistory.filter(row => row.at > Date.now() - 3600000).slice(-900);
    history.push(point);
    history = history.filter(row => row.at > Date.now() - hours * 3600000).slice(-900);
    renderCharts();
    if (view === 'trends') renderHistory();
  }
}
function connectEvents() {
  source?.close();
  if (!navigator.onLine) { feedUp = false; renderState(); return; }
  source = new EventSource('/api/events');
  source.onopen = () => { feedUp = true; backoff = 1000; renderState(); };
  source.addEventListener('snapshot', event => receiveState(JSON.parse(event.data)));
  source.addEventListener('data', event => receiveState(JSON.parse(event.data), true));
  source.addEventListener('status', event => receiveState(JSON.parse(event.data)));
  source.addEventListener('ack', () => loadLogs().catch(() => {}));
  source.onerror = () => {
    source.close(); feedUp = false; renderState();
    clearTimeout(reconnect);
    reconnect = setTimeout(async () => {
      try { await api('/api/session'); connectEvents(); } catch { if (!$('app').hidden) connectEvents(); }
    }, backoff + Math.random() * 300);
    backoff = Math.min(backoff * 2, 30000);
  };
}
async function sendCommand(body, { quiet = false } = {}) {
  if (!isLive()) { toast('设备离线，命令未下发', true); return null; }
  busy++; renderState();
  try {
    const ack = await api('/api/command', { method: 'POST', body: JSON.stringify(body) });
    lastCommand = { ...ack, at: Date.now() };
    if (!quiet || !ack.applied) toast(`${ack.applied ? '已应用' : '未应用'}：${ack.applied ? commandName(body) : reasons[ack.reason] || ack.reason}`, !ack.applied);
    if (ack.applied && body.action === 'angle') angleDirty = false;
    await loadLogs();
    return ack;
  } catch (error) { lastCommand = { applied: false, reason: 'RESULT_UNKNOWN', at: Date.now() }; reportError(error); return null; }
  finally { busy--; renderState(); }
}
async function confirm(title, message) {
  text('confirm-title', title); text('confirm-text', message);
  const dialog = $('confirm-dialog');
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

function clearAccess(message) {
  accessDrawing++;
  $('access-qr').hidden = true;
  $('access-url').hidden = true;
  $('access-url').removeAttribute('href');
  text('access-url', '');
  $('access-empty').hidden = false;
  text('access-empty', message);
  $('copy-access').disabled = $('download-access').disabled = true;
}
async function drawAccess() {
  const selected = accessAddresses.find(entry => entry.url === $('access-network').value);
  clearAccess('正在生成二维码');
  if (!selected) { text('access-empty', '未发现可用的访问地址'); return; }
  const drawing = accessDrawing;
  const url = new URL(selected.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_ADDRESS');
  // Draw offscreen first so a slow, obsolete render cannot replace a newer address.
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, url.href, { width: 256, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#142c27', light: '#ffffff' } });
  if (drawing !== accessDrawing || !$('access-dialog').open) return;
  const target = $('access-qr');
  target.width = canvas.width; target.height = canvas.height;
  target.getContext('2d').drawImage(canvas, 0, 0);
  target.hidden = false;
  $('access-empty').hidden = true;
  text('access-url', url.href);
  $('access-url').href = url.href;
  $('access-url').hidden = false;
  $('copy-access').disabled = $('download-access').disabled = false;
  $('access-warning').hidden = selected.scope !== 'lan';
}
async function refreshAccess() {
  const request = ++accessRequest;
  $('refresh-access').disabled = true;
  try {
    const data = await api('/api/access');
    if (request !== accessRequest || !$('access-dialog').open) return;
    const select = $('access-network'), previous = select.value;
    accessAddresses = data.addresses;
    select.replaceChildren();
    for (const entry of accessAddresses) select.append(new Option(`${entry.name} · ${new URL(entry.url).hostname}`, entry.url));
    if (!accessAddresses.length) select.append(new Option('未发现地址', ''));
    select.value = accessAddresses.some(entry => entry.url === previous) ? previous : accessAddresses[0]?.url || '';
    select.disabled = accessAddresses.length < 2;
    if (select.value !== $('access-url').getAttribute('href') || $('access-qr').hidden) await drawAccess();
    if (request === accessRequest) text('access-status', `更新于 ${time(data.updatedAt)}`);
  } catch {
    if (request !== accessRequest || !$('access-dialog').open) return;
    accessAddresses = [];
    $('access-network').replaceChildren(new Option('无法读取地址', ''));
    $('access-network').disabled = true;
    clearAccess('无法读取网络地址');
    text('access-status', '连接中断');
  } finally { if (request === accessRequest) $('refresh-access').disabled = false; }
}
async function openAccess() {
  $('access-dialog').showModal();
  clearAccess('正在读取网络地址');
  text('access-status', '');
  clearInterval(accessTimer);
  accessTimer = setInterval(() => { if (!$('refresh-access').disabled) refreshAccess(); }, 15000);
  await refreshAccess();
}
async function copyAccess() {
  const url = $('access-url').getAttribute('href');
  if (!url || $('copy-access').disabled) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
    await navigator.clipboard.writeText(url);
  } catch {
    const focused = document.activeElement;
    const buffer = element('textarea', 'clipboard-buffer');
    buffer.value = url;
    $('access-dialog').append(buffer);
    buffer.select();
    const copied = document.execCommand('copy');
    buffer.remove(); focused?.focus();
    if (!copied) throw new Error('CLIPBOARD_UNAVAILABLE');
  }
  toast('访问地址已复制');
}

const metricInfo = { current: ['采样电流', 'mA', '#168b75'], panelTemp: ['环境温度', '°C', '#c78a3b'], dustLevel: ['积灰估计', '%', '#7c86b6'], tiltAngle: ['指令角度', '°', '#438daf'] };
function newChart(canvas) {
  return new Chart(canvas, { type: 'line', data: { datasets: [] }, options: {
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#263f43', padding: 10,
      callbacks: { title: items => time(items[0].parsed.x) } } },
    scales: {
      x: { type: 'linear', grid: { display: false }, border: { display: false },
        ticks: { color: '#9aa9b0', maxTicksLimit: 5, font: { size: 10 }, callback: value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) } },
      y: { beginAtZero: true, border: { display: false }, grid: { color: '#e8eef0', drawTicks: false },
        ticks: { color: '#9aa9b0', maxTicksLimit: 4, font: { size: 10 }, padding: 8 } }
    }
  } });
}
function updateChart(chart, rows, metric) {
  if (!chart) return;
  const [label, unit, color] = metricInfo[metric];
  chart.data.datasets = [{ label: `${label} (${unit})`, data: rows.map(row => ({ x: row.at,
    y: observed(row, metric) })),
    borderColor: color, backgroundColor: color + '0c', fill: true, borderWidth: 1.8,
    pointRadius: rows.length < 4 ? 2.5 : 0, pointHoverRadius: 4, tension: .25, spanGaps: false }];
  chart.update('none');
}
function renderCharts() {
  updateChart(overviewChart, overviewHistory, 'current');
  updateChart(trendChart, history, $('chart-metric').value);
  $('overview-empty').hidden = overviewHistory.length > 0;
  $('trend-empty').hidden = history.length > 0;
}
function element(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}
function renderHistory() {
  text('history-count', `${history.length} 条（按时间聚合）`);
  const body = $('history-rows');
  body.replaceChildren();
  if (!history.length) {
    const tr = element('tr'), td = element('td', 'empty-state', '暂无采样记录'); td.colSpan = 6; tr.append(td); body.append(tr); return;
  }
  for (const row of history.slice(-20).reverse()) {
    const tr = element('tr');
    for (const value of [time(row.at), observed(row, 'current') ?? '--',
      observed(row, 'panelTemp') ?? '--', observed(row, 'dustLevel') ?? '--', row.tiltAngle,
      row.alarm ? '保护 / 报警' : row.cleaning ? '清扫中' : '正常']) tr.append(element('td', '', String(value)));
    body.append(tr);
  }
}
let historyRequest = 0;
async function loadHistory() {
  const request = ++historyRequest;
  const data = await api(`/api/history?hours=${hours}`);
  if (request !== historyRequest) return;
  history = data;
  renderCharts(); renderHistory();
}
function commandName(cmd) {
  if (cmd.action === 'angle' && cmd.value === 0) return '收起至 0°';
  if (cmd.action === 'angle' && cmd.value === 90) return '挡雨至 90°';
  if (cmd.action === 'angle') return `倾角设定为 ${cmd.value}°`;
  if (cmd.action === 'clean') return cmd.value ? '启动组件清扫' : '停止组件清扫';
  if (cmd.action === 'mode') return cmd.value ? '切换自动清扫' : '切换手动模式';
  if (cmd.action === 'pirAlarm') return cmd.value ? '开启人体报警' : '关闭人体报警（维修）';
  return actionNames[cmd.action] || cmd.action;
}
function eventResult(row) {
  return row.ack ? row.ack.applied ? ['已应用', ''] : [reasons[row.ack.reason] || row.ack.reason, ' rejected'] : ['等待回执', ' pending'];
}
function eventIcon(row) {
  const el = element('div', 'event-icon'), icon = element('i');
  icon.dataset.lucide = row.ack ? row.ack.applied ? 'check' : 'x' : 'clock';
  el.append(icon); return el;
}
function renderLogs() {
  const recent = $('recent-events'); recent.replaceChildren();
  if (!logs.length) recent.append(element('p', 'empty-state', '暂无操作记录'));
  for (const row of logs.slice(0, 3)) {
    const entry = element('div', 'recent-row'), [result, cls] = eventResult(row);
    entry.append(eventIcon(row), element('span', 'event-name', commandName(row.command)), element('span', 'event-result' + cls, result), element('span', 'event-time', time(row.at)));
    recent.append(entry);
  }
  const filter = $('event-filter').value;
  const filtered = logs.filter(row => filter === 'all' || (filter === 'success' ? row.ack?.applied : row.ack && !row.ack.applied));
  text('event-count', `${filtered.length} 条记录`);
  const list = $('event-list'); list.replaceChildren();
  if (!filtered.length) list.append(element('p', 'empty-state', '暂无匹配记录'));
  for (const row of filtered) {
    const entry = element('div', 'event-row'), summary = element('div'), [result, cls] = eventResult(row);
    summary.append(element('div', 'event-name', commandName(row.command)), element('div', 'event-id', row.cmdId.slice(0, 12)));
    entry.append(eventIcon(row), summary, element('span', 'event-result' + cls, result), element('span', 'event-time', dateTime(row.at)));
    list.append(entry);
  }
  refreshIcons();
}
async function loadLogs() { logs = await api('/api/logs'); renderLogs(); }
async function loadPorts() {
  if (snapshot?.simulation || snapshot?.role === 'cloud') return;
  const ports = await api('/api/ports'), select = $('serial-port');
  const selected = select.value || snapshot?.connection.port || '';
  select.replaceChildren(new Option(ports.length ? '选择 USB 串口' : '未发现串口', ''));
  for (const port of ports) select.append(new Option(`${port.path}${port.manufacturer ? ' · ' + port.manufacturer : ''}`, port.path));
  if (ports.some(port => port.path === selected)) select.value = selected;
}
async function bootstrap() {
  await api('/api/session');
  const state = await api('/api/state');
  feedUp = true;
  $('login').hidden = true; $('app').hidden = false;
  receiveState(state);
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (!overviewChart) overviewChart = newChart($('overview-chart'));
  if (!trendChart) trendChart = newChart($('trend-chart'));
  overviewHistory = await api('/api/history?hours=1');
  await Promise.all([loadHistory(), loadLogs()]);
  renderCharts(); connectEvents();
}
const handle = (id, fn, event = 'click') => $(id).addEventListener(event, e => { Promise.resolve(fn(e)).catch(reportError); });
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
handle('login-form', async e => {
  e.preventDefault();
  const button = $('login-form').querySelector('button'); button.disabled = true; text('login-error', '');
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); $('password').value = ''; await bootstrap(); }
  catch (error) { text('login-error', reasons[error.message] || '无法连接服务'); }
  finally { button.disabled = false; }
}, 'submit');
handle('logout', async () => { await api('/api/logout', { method: 'POST' }); showLogin(); });
handle('open-access', () => openAccess());
handle('close-access', () => $('access-dialog').close());
handle('refresh-access', () => refreshAccess());
handle('access-network', () => drawAccess(), 'change');
handle('copy-access', () => copyAccess());
handle('download-access', () => {
  if ($('download-access').disabled) return;
  const anchor = document.createElement('a');
  anchor.href = $('access-qr').toDataURL('image/png');
  anchor.download = 'pv-phone-access.png';
  anchor.click();
});
$('access-dialog').addEventListener('close', () => {
  clearInterval(accessTimer);
  accessRequest++; accessDrawing++;
  accessAddresses = [];
  clearAccess('');
});
handle('open-connection', () => setView('settings'));
handle('all-events', () => setView('events'));
handle('angle-range', () => { angleDirty = true; text('angle-output', `${$('angle-range').value}°`); }, 'input');
function stepAngle(delta) { angleDirty = true; $('angle-range').value = Math.max(0, Math.min(90, Number($('angle-range').value) + delta)); text('angle-output', `${$('angle-range').value}°`); }
handle('angle-minus', () => stepAngle(-5));
handle('angle-plus', () => stepAngle(5));
handle('angle-apply', () => sendCommand({ action: 'angle', value: Number($('angle-range').value) }));
handle('servo-stow', () => sendCommand({ action: 'angle', value: 0 }));
handle('servo-shield', () => sendCommand({ action: 'angle', value: 90 }));
handle('mode-manual', () => sendCommand({ action: 'mode', value: 0 }));
handle('mode-auto', () => sendCommand({ action: 'mode', value: 1 }));
handle('clean-toggle', () => sendCommand({ action: 'clean', value: snapshot.data.cleaning ? 0 : 1 }));
handle('safe-stop', () => sendCommand({ action: 'stop', value: 1 }));
handle('resume-motion', () => sendCommand({ action: 'resume', value: 1 }));
handle('silence', () => sendCommand({ action: 'silence', value: 1 }));
handle('pir-alarm-toggle', () => {
  const value = $('pir-alarm-toggle').checked ? 1 : 0;
  renderState();
  return sendCommand({ action: 'pirAlarm', value });
}, 'change');
handle('calibrate-baseline', async () => {
  if (await confirm('标定清洁基准', `确认组件表面清洁，并将当前 ${snapshot.data.current} mA 设为清洁电流基准？`)) await sendCommand({ action: 'baseline', value: 1 });
});
handle('settings-form', () => { settingsDirty = true; }, 'input');
async function applySettings() {
  const form = $('settings-form');
  if (!form.reportValidity()) return null;
  const body = { action: 'settings' };
  for (const key of settingsKeys) body[key] = Number(form.elements[key].value);
  const ack = await sendCommand(body, { quiet: true });
  if (ack?.applied) { settingsDirty = false; toast('运行参数已应用，尚未写入 Flash'); }
  return ack;
}
handle('settings-form', async e => { e.preventDefault(); await applySettings(); }, 'submit');
handle('save-settings', async () => {
  if (settingsDirty && !(await applySettings())?.applied) return;
  await sendCommand({ action: 'save', value: 1 });
});
handle('refresh-ports', () => loadPorts());
handle('connection-form', async e => {
  e.preventDefault();
  if (!$('serial-port').value) { toast('请选择 USB 串口', true); return; }
  receiveState(await api('/api/connection', { method: 'POST', body: JSON.stringify({ port: $('serial-port').value }) }));
  toast('串口已选择，等待设备上报');
}, 'submit');
handle('disconnect-port', async () => receiveState(await api('/api/connection', { method: 'POST', body: JSON.stringify({ port: '' }) })));
handle('refresh-events', () => loadLogs());
handle('event-filter', () => renderLogs(), 'change');
handle('chart-metric', () => renderCharts(), 'change');
for (const button of document.querySelectorAll('[data-hours]')) button.addEventListener('click', () => {
  hours = Number(button.dataset.hours);
  for (const item of document.querySelectorAll('[data-hours]')) item.classList.toggle('active', item === button);
  loadHistory().catch(reportError);
});
handle('export-csv', async () => {
  const response = await fetch(`/api/export.csv?hours=${hours}`);
  if (!response.ok) throw new Error('NETWORK_ERROR');
  const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'pv-history.csv'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
refreshIcons();
window.addEventListener('offline', () => { feedUp = false; source?.close(); clearTimeout(reconnect); renderState(); });
window.addEventListener('online', () => { if (!$('app').hidden) connectEvents(); });
setInterval(() => { if (!$('app').hidden) renderState(); }, 1000);
bootstrap().catch(() => showLogin());
