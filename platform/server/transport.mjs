import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import mqtt from 'mqtt';

export class MqttLink extends EventEmitter {
  constructor({ url, username, password, deviceId, role, allowInsecure = false }) {
    super();
    this.role = role;
    this.prefix = `pv/${deviceId}/`;
    this.client = null;
    this.error = null;
    if (!url) return;
    const parsed = new URL(url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (!loopback && (!username || !password)) throw new Error('A private MQTT username and password are required');
    if (!['mqtts:', 'wss:'].includes(parsed.protocol) && !(allowInsecure && loopback && ['mqtt:', 'ws:'].includes(parsed.protocol)))
      throw new Error('Cloud MQTT requires mqtts:// or wss:// with a verified TLS certificate');
    this.client = mqtt.connect(url, {
      username, password, rejectUnauthorized: true, clean: true, connectTimeout: 8000,
      reconnectPeriod: 3000, keepalive: 15, queueQoSZero: false,
      clientId: `pv-${role}-${deviceId}-${process.pid}`,
      ...(role === 'gateway' ? { will: { topic: this.prefix + 'presence', payload: JSON.stringify({ online: false }), qos: 1, retain: true } } : {})
    });
    this.client.on('connect', () => {
      this.error = null;
      this.client.subscribe((role === 'gateway' ? ['cmd'] : ['data', 'ack', 'presence']).map(t => this.prefix + t), { qos: 1 }, error => {
        if (error) this.error = 'MQTT_SUBSCRIBE_FAILED';
        this.emit('status');
      });
      this.emit('status');
    });
    this.client.on('error', () => { this.error = 'MQTT_CONNECTION_FAILED'; this.emit('status'); });
    this.client.on('offline', () => this.emit('status'));
    this.client.on('close', () => this.emit('status'));
    this.client.on('message', (topic, bytes, packet) => {
      if (bytes.length > 4096) return;
      try {
        const frame = JSON.parse(bytes.toString('utf8'));
        const kind = topic.slice(this.prefix.length);
        if (kind === 'cmd' && !packet.retain) this.emit('command', frame);
        else if (kind === 'data' && !packet.retain && Number.isSafeInteger(frame.sentAt) && Math.abs(Date.now() - frame.sentAt) < 10000) this.emit('data', frame);
        else if (kind === 'ack' && !packet.retain) this.emit('ack', frame);
        else if (kind === 'presence') this.emit('presence', Boolean(frame.online));
      } catch { /* Ignore malformed broker frames. */ }
    });
  }
  get connected() { return Boolean(this.client?.connected); }
  status() { return { configured: Boolean(this.client), connected: this.connected, error: this.error }; }
  publish(kind, body, retain = false) {
    if (!this.connected) return Promise.reject(new Error('CLOUD_OFFLINE'));
    return this.client.publishAsync(this.prefix + kind, JSON.stringify(body), { qos: 1, retain });
  }
  async close() { if (this.client) await this.client.endAsync(true); }
}

export class SerialTransport extends EventEmitter {
  constructor({ path = '', link = null } = {}) {
    super();
    this.path = path;
    this.port = null;
    this.link = link;
    this.buffer = '';
    this.dropping = false;
    this.error = null;
    this.stopped = false;
    link?.on('command', cmd => this.emit('command', cmd));
    link?.on('status', () => this.emit('status'));
    this.reconnect = setInterval(() => { if (this.path && !this.port && !this.stopped) this.open(); }, 3000);
    if (path) this.open();
  }
  get connected() { return Boolean(this.port?.isOpen); }
  status() { return { kind: 'serial', port: this.path || null, connected: this.connected, error: this.error, cloud: this.link?.status() || { configured: false, connected: false } }; }
  async setPort(path) {
    const available = await SerialPort.list();
    if (path && !available.some(port => port.path === path)) throw new Error('PORT_NOT_FOUND');
    this.path = '';
    await this.closePort();
    this.buffer = '';
    this.dropping = false;
    this.path = path;
    if (path) this.open();
    this.emit('status');
  }
  open() {
    if (this.port || !this.path || this.stopped) return;
    const port = new SerialPort({ path: this.path, baudRate: 115200, autoOpen: false, lock: true });
    this.port = port;
    port.on('data', bytes => this.receive(bytes));
    port.on('error', () => { this.error = 'SERIAL_ERROR'; this.emit('status'); });
    port.on('close', () => { if (this.port === port) this.port = null; this.emit('status'); });
    port.open(error => {
      if (error) { if (this.port === port) this.port = null; this.error = 'SERIAL_OPEN_FAILED'; }
      else this.error = null;
      this.emit('status');
    });
  }
  receive(bytes) {
    for (const ch of bytes.toString('utf8')) {
      if (ch === '\n') {
        if (!this.dropping && this.buffer.trim()) {
          try {
            const frame = JSON.parse(this.buffer);
            if (frame.type === 'data') this.emit('data', frame);
            else if (frame.type === 'ack') this.emit('ack', frame);
          } catch { /* Noise and incomplete serial frames are not telemetry. */ }
        }
        this.buffer = '';
        this.dropping = false;
      } else if (!this.dropping) {
        if (this.buffer.length >= 4096) { this.buffer = ''; this.dropping = true; }
        else this.buffer += ch;
      }
    }
  }
  send(cmd) {
    if (!this.connected) return Promise.reject(new Error('DEVICE_OFFLINE'));
    const { issuedAt, ...frame } = cmd;
    return new Promise((resolve, reject) => this.port.write(JSON.stringify(frame) + '\n', error => error ? reject(error) : resolve()));
  }
  upstream(kind, data) { this.link?.publish(kind, data).catch(() => {}); }
  presence(online) { this.link?.publish('presence', { online, at: Date.now() }, true).catch(() => {}); }
  closePort() {
    const port = this.port;
    this.port = null;
    return new Promise(resolve => { if (port?.isOpen) port.close(() => resolve()); else resolve(); });
  }
  async close() {
    this.stopped = true;
    clearInterval(this.reconnect);
    this.presence(false);
    await this.closePort();
    await this.link?.close();
  }
}

export class CloudTransport extends EventEmitter {
  constructor(link) {
    super();
    this.link = link;
    this.present = null;
    link.on('data', frame => { this.present = true; this.emit('data', frame); });
    link.on('ack', ack => this.emit('ack', ack));
    link.on('presence', online => { this.present = online; this.emit('status'); });
    link.on('status', () => this.emit('status'));
  }
  get connected() { return this.link.connected && this.present !== false; }
  status() { return { kind: 'cloud', connected: this.connected, cloud: this.link.status() }; }
  send(cmd) { return this.link.publish('cmd', cmd); }
  close() { return this.link.close(); }
}

export class Simulator extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.started = Date.now();
    this.cache = new Map();
    this.endsAt = 0;
    this.rainEpisode = 'idle';
    this.dryAt = null;
    this.state = { type: 'data', protocol: 3, seq: 0, uptimeS: 0, current: 740, panelTemp: 31, rain: 0, dustLevel: null,
      tiltAngle: 0, targetAngle: 0, cleaning: false, mode: 'manual', alarm: 0, quality: 'uncalibrated',
      baselineMa: 0, dustThreshold: 40, tempThreshold: 65, cleanSeconds: 10, autoCooldownS: 900, adcCurrent: 2780,
      adcVoltage: 1058, temperatureRaw: 29000, validFlags: 7, temperatureStatus: 'ok', saved: false,
      rainProtection: 'idle', rainDryRemainingS: 0, motionPaused: false,
      personDetected: null, pirStatus: 'warming', pirWarmupRemainingS: 60,
      ld1Mode: 'idle', ntcAdc: 1940, ntcStatus: 'estimated', surfaceTemp: 27.4, pirAlarmEnabled: true };
    this.timer = setInterval(() => this.tick(), 1000);
    this.first = setTimeout(() => this.tick(), 50);
  }
  status() { return { kind: 'simulation', connected: true, cloud: { configured: false, connected: false } }; }
  updateRain(now = Date.now()) {
    const s = this.state;
    if (!(s.validFlags & 4)) {
      if (this.rainEpisode !== 'idle') { this.rainEpisode = 'rain'; s.targetAngle = s.tiltAngle; }
      this.dryAt = null;
      s.rainProtection = 'unavailable';
      s.rainDryRemainingS = 0;
      return;
    }
    if (s.rain) {
      s.cleaning = false; s.mode = 'manual';
      this.rainEpisode = 'rain'; this.dryAt = null;
      if (!s.motionPaused) s.targetAngle = 90;
    } else {
      if (this.rainEpisode === 'rain') { this.rainEpisode = 'drying'; this.dryAt = now; }
      if (!s.motionPaused && this.rainEpisode === 'drying') {
        s.targetAngle = 90;
        if (now - this.dryAt >= 10000) this.rainEpisode = 'returning';
      }
      if (!s.motionPaused && this.rainEpisode === 'returning') {
        s.targetAngle = 0;
        if (s.tiltAngle === 0) this.rainEpisode = 'idle';
      }
    }
    s.rainProtection = this.rainEpisode;
    s.rainDryRemainingS = this.rainEpisode === 'drying' ? Math.max(0, Math.ceil((10000 - (now - this.dryAt)) / 1000)) : 0;
  }
  startReason() {
    const s = this.state;
    if (s.motionPaused) return 'MOTION_PAUSED';
    if ((s.validFlags & 3) !== 3) return 'SENSOR_FAULT';
    if (!(s.validFlags & 4)) return 'RAIN_UNAVAILABLE';
    if (s.rain) return 'RAIN_INTERLOCK';
    if (this.rainEpisode !== 'idle') return 'RAIN_RECOVERY';
    if (s.panelTemp >= s.tempThreshold) return 'TEMP_INTERLOCK';
    if (s.tiltAngle !== s.targetAngle) return 'BUSY';
    return 'OK';
  }
  tick() {
    const s = this.state;
    this.updateRain();
    s.uptimeS = Math.floor((Date.now() - this.started) / 1000);
    if (s.pirStatus === 'warming') {
      s.pirWarmupRemainingS = Math.max(0, 60 - s.uptimeS);
      if (!s.pirWarmupRemainingS) { s.pirStatus = 'ok'; s.personDetected = false; }
    }
    s.seq++;
    s.current = Math.round(740 + Math.sin(s.uptimeS / 8) * 25);
    s.tiltAngle = s.targetAngle;
    s.dustLevel = s.baselineMa ? Math.max(0, Math.round(100 - s.current * 100 / s.baselineMa)) : 0;
    s.quality = s.baselineMa >= 50 ? 'estimated' : 'uncalibrated';
    if (s.quality !== 'estimated') s.dustLevel = null;
    s.alarm = (s.rain ? 4 : 0) | (s.panelTemp >= s.tempThreshold ? 2 : 0) | (s.dustLevel >= s.dustThreshold ? 1 : 0) |
      (s.pirAlarmEnabled && s.pirStatus === 'ok' && s.personDetected ? 16 : 0);
    if (Date.now() >= this.endsAt || s.rain || s.panelTemp >= s.tempThreshold) s.cleaning = false;
    s.ld1Mode = s.alarm ? 'alarm' : s.cleaning ? 'cleaning' : s.motionPaused ? 'paused' : 'idle';
    this.emit('data', { ...s });
  }
  send(cmd) {
    if (this.cache.has(cmd.cmdId)) { setTimeout(() => this.emit('ack', this.cache.get(cmd.cmdId)), 20); return; }
    const s = this.state;
    this.updateRain();
    let reason = 'OK';
    if (cmd.action === 'pirAlarm') s.pirAlarmEnabled = Boolean(cmd.value);
    else if (cmd.action === 'angle') {
      if (s.motionPaused) reason = 'MOTION_PAUSED';
      else if (!(s.validFlags & 4)) reason = 'RAIN_UNAVAILABLE';
      else if (this.rainEpisode !== 'idle' && (cmd.value !== 90 || this.rainEpisode === 'returning')) reason = s.rain ? 'RAIN_INTERLOCK' : 'RAIN_RECOVERY';
      else s.targetAngle = cmd.value;
    }
    else if (cmd.action === 'clean') {
      if (cmd.value) reason = this.startReason();
      if (reason === 'OK') { if (cmd.value && !s.cleaning) this.endsAt = Date.now() + s.cleanSeconds * 1000; s.cleaning = Boolean(cmd.value); }
    } else if (cmd.action === 'mode') {
      if (cmd.value && s.baselineMa < 50) reason = 'BASELINE_REQUIRED';
      else if (cmd.value) reason = this.startReason();
      if (reason === 'OK') { s.mode = cmd.value ? 'auto' : 'manual'; if (!cmd.value) s.cleaning = false; }
    }
    else if (cmd.action === 'stop') { s.cleaning = false; s.mode = 'manual'; s.targetAngle = s.tiltAngle; s.motionPaused = true; }
    else if (cmd.action === 'resume') {
      if (!(s.validFlags & 4)) reason = 'RAIN_UNAVAILABLE';
      else { s.motionPaused = false; this.updateRain(); }
    }
    else if (cmd.action === 'baseline') {
      reason = s.cleaning ? 'BUSY' : this.startReason();
      if (reason === 'OK' && s.current < 50) reason = 'LOW_CURRENT';
      if (reason === 'OK') { s.baselineMa = s.current; s.saved = false; }
    }
    else if (cmd.action === 'settings') { if (s.cleaning) reason = 'BUSY'; else { for (const key of ['dustThreshold', 'tempThreshold', 'cleanSeconds', 'autoCooldownS']) s[key] = cmd[key]; s.saved = false; } }
    else if (cmd.action === 'save') { if (s.cleaning) reason = 'BUSY'; else s.saved = true; }
    const ack = { type: 'ack', cmdId: cmd.cmdId, accepted: reason === 'OK', applied: reason === 'OK', reason };
    this.cache.set(cmd.cmdId, ack);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    setTimeout(() => { this.emit('ack', ack); this.tick(); }, 30);
  }
  async close() { clearInterval(this.timer); clearTimeout(this.first); }
}
export const listPorts = () => SerialPort.list();
