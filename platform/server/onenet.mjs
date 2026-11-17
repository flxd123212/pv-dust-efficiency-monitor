import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { makeOneNetToken, ONENET_TOKEN_TTL_S } from './onenet-token.mjs';
import { validateData } from './contract.mjs';

export const ONENET_URL = 'mqtts://mqttstls.heclouds.com:8883';
const ONENET_CERT_SHA256 = '7de9bc4c1aed01344667645678d449741210b17049489838bf637953b3e90117';
const FIELDS = ['current', 'panelTemp', 'rain', 'dustLevel', 'tiltAngle', 'personDetected', 'surfaceTemp'];
const EXTRA_FIELDS = ['personDetected', 'surfaceTemp'];
const requestId = id => typeof id === 'string' && /^[0-9]{1,13}$/.test(id);

export function verifyOneNetIdentity(host, certificate) {
  // The official self-signed server certificate has no DNS SAN: pin its exact public certificate.
  if (host !== 'mqttstls.heclouds.com' || !Buffer.isBuffer(certificate?.raw) ||
    createHash('sha256').update(certificate.raw).digest('hex') !== ONENET_CERT_SHA256)
    return new Error('ONENET_CERTIFICATE_MISMATCH');
}

export function oneNetProperties(frame, receivedAt, now = Date.now()) {
  if (!Number.isSafeInteger(receivedAt) || now < receivedAt || now - receivedAt >= 5000) return {};
  const data = validateData(frame);
  if (!data || data.protocol !== 3) return {};
  return Object.fromEntries(FIELDS.filter(key => {
    if (key === 'personDetected') return data.pirStatus === 'ok' && typeof data.personDetected === 'boolean';
    if (key === 'surfaceTemp') return data.ntcStatus === 'estimated' && Number.isFinite(data.surfaceTemp);
    return data[key] !== null;
  }).map(key => [key, data[key]]));
}

export function bindOneNetHub(link, hub) {
  link.snapshot = () => hub.snapshot();
  link.command = (id, value) => {
    const cmdId = createHash('sha256').update(`onenet:${link.productId}:${link.deviceName}:${id}`).digest('hex').slice(0, 32);
    const issuedAt = hub.store.command(cmdId)?.command.issuedAt ?? Date.now();
    const body = { action: 'angle', value };
    return hub.command(body, { type: 'cmd', cmdId, issuedAt, ...body });
  };
}

export class OneNetLink extends EventEmitter {
  constructor({ productId, deviceName, deviceKey, url = ONENET_URL, reportMs = 5000,
    tokenTtlS = ONENET_TOKEN_TTL_S, allowInsecure = false, now = Date.now } = {}) {
    super();
    Object.assign(this, { productId, deviceName, deviceKey, reportMs, tokenTtlS, now });
    const parsed = new URL(url);
    const testBroker = allowInsecure && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.protocol === 'mqtt:';
    if (!testBroker && url !== ONENET_URL) throw new Error('OneNET requires its official verified TLS endpoint');
    if (!Number.isInteger(reportMs) || reportMs < 1000 || reportMs > 60000 || !Number.isInteger(tokenTtlS) || tokenTtlS < 120 || tokenTtlS > 86400)
      throw new Error('Invalid OneNET report interval or token lifetime');
    this.prefix = `$sys/${productId}/${deviceName}/thing/property/`;
    this.ready = false;
    this.stopped = false;
    this.error = null;
    this.reportError = null;
    this.latest = null;
    this.pendingPost = null;
    this.lastAttemptAt = null;
    this.lastReportAt = null;
    this.lastReportFields = [];
    this.lastPostCode = null;
    this.extensionReportError = null;
    this.extensionRetryAt = 0;
    this.messageId = this.now();
    this.session = 0;
    this.snapshot = null;
    this.command = null;
    const password = this.newToken();
    this.client = mqtt.connect(url, { protocolVersion: 4, clientId: deviceName, username: productId, password,
      ...(!testBroker ? { ca: readFileSync(new URL('../certs/onenet/certificate.pem', import.meta.url)),
        servername: 'mqttstls.heclouds.com', checkServerIdentity: verifyOneNetIdentity } : {}),
      rejectUnauthorized: true, clean: true, resubscribe: false, connectTimeout: 8000,
      reconnectPeriod: 3000, keepalive: 30, queueQoSZero: false });
    this.client.on('reconnect', () => { this.client.options.password = this.newToken(); });
    this.client.on('connect', () => this.subscribe());
    this.client.on('error', () => { this.error = 'ONENET_CONNECTION_FAILED'; this.emit('status'); });
    this.client.on('close', () => {
      this.ready = false;
      this.pendingPost = null;
      this.session++;
      clearTimeout(this.renewTimer);
      this.emit('status');
    });
    this.client.on('message', (topic, bytes, packet) => {
      this.receive(topic, bytes, packet).catch(() => { this.reportError = 'ONENET_MESSAGE_FAILED'; this.emit('status'); });
    });
    this.timer = setInterval(() => this.flush(), 1000);
  }
  newToken() {
    this.tokenExpiresAt = Math.floor(this.now() / 1000) + this.tokenTtlS;
    return makeOneNetToken({ productId: this.productId, deviceName: this.deviceName,
      deviceKey: this.deviceKey, expiresAt: this.tokenExpiresAt });
  }
  get connected() { return this.ready && Boolean(this.client?.connected); }
  status() {
    return { provider: 'onenet', configured: true, connected: this.connected, error: this.error,
      reportError: this.reportError, tokenExpiresAt: this.tokenExpiresAt * 1000, lastReportAt: this.lastReportAt,
      lastReportFields: this.lastReportFields, lastPostCode: this.lastPostCode,
      extensionReportError: this.extensionReportError, extensionRetryAt: this.extensionRetryAt };
  }
  subscribe() {
    const session = this.session;
    this.client.subscribe(['post/reply', 'set', 'get'].map(kind => this.prefix + kind), { qos: 1 }, (error, grants) => {
      if (this.stopped || session !== this.session) return;
      if (error || !grants?.length || grants.some(grant => grant.qos === 128)) {
        this.error = 'ONENET_SUBSCRIBE_FAILED';
        this.emit('status');
        return;
      }
      this.error = null;
      this.ready = true;
      this.lastAttemptAt = null;
      clearTimeout(this.renewTimer);
      this.renewTimer = setTimeout(() => this.renew(), Math.max(1000, this.tokenExpiresAt * 1000 - this.now() - 60000));
      this.emit('status');
      this.flush();
    });
  }
  renew() {
    if (this.stopped) return;
    this.ready = false;
    this.emit('status');
    this.client.end(true, () => { if (!this.stopped) this.client.reconnect(); });
  }
  async publish(kind, body) {
    if (kind === 'data') {
      this.latest = validateData(body)?.protocol === 3 && Number.isSafeInteger(body.sentAt) ? body : null;
      this.flush();
    } else if (kind === 'presence' && !body.online) this.latest = null;
  }
  flush() {
    if (!this.connected || this.stopped) return;
    const now = this.now();
    if (this.pendingPost && now - this.pendingPost.startedAt >= 8000) {
      this.pendingPost = null;
      this.reportError = 'ONENET_REPORT_TIMEOUT';
      this.emit('status');
    }
    if (this.pendingPost || (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.reportMs)) return;
    const data = this.latest;
    const values = oneNetProperties(data, data?.sentAt, now);
    if (now < this.extensionRetryAt) for (const key of EXTRA_FIELDS) delete values[key];
    if (!Object.keys(values).length) return;
    const id = String(this.messageId = Math.max(this.messageId + 1, now));
    const params = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, time: data.sentAt }]));
    const pending = { id, startedAt: now, fields: Object.keys(values) };
    this.pendingPost = pending;
    this.lastAttemptAt = now;
    // QoS 0 plus OneJSON business receipts avoids replaying stale offline telemetry.
    this.client.publish(this.prefix + 'post', JSON.stringify({ id, version: '1.0', params }), { qos: 0, retain: false }, error => {
      if (error && this.pendingPost === pending) {
        this.pendingPost = null;
        this.reportError = 'ONENET_PUBLISH_FAILED';
        this.emit('status');
      }
    });
  }
  async reply(kind, id, code, msg, session, data) {
    if (!this.connected || session !== this.session || this.stopped) return;
    const body = { id, code, msg, ...(data ? { data } : {}) };
    await this.client.publishAsync(this.prefix + kind + '_reply', JSON.stringify(body), { qos: 0, retain: false });
  }
  async receive(topic, bytes, packet = {}) {
    if (!this.connected || packet.retain || bytes.length > 4096 || !topic.startsWith(this.prefix)) return;
    let frame;
    try { frame = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (!frame || typeof frame !== 'object' || !requestId(frame.id)) return;
    const kind = topic.slice(this.prefix.length);
    if (kind === 'post/reply') {
      if (!this.pendingPost || frame.id !== this.pendingPost.id || !Number.isInteger(frame.code)) return;
      this.lastPostCode = frame.code;
      if (frame.code === 200) {
        this.lastReportAt = this.now();
        this.lastReportFields = this.pendingPost.fields;
        this.reportError = null;
        if (this.pendingPost.fields.some(key => EXTRA_FIELDS.includes(key))) {
          this.extensionReportError = null;
          this.extensionRetryAt = 0;
        }
      } else {
        this.reportError = 'ONENET_MODEL_REJECTED';
        if (this.pendingPost.fields.some(key => EXTRA_FIELDS.includes(key))) {
          this.extensionReportError = 'ONENET_EXTENSION_MODEL_REJECTED';
          this.extensionRetryAt = this.now() + 60000;
        }
      }
      this.pendingPost = null;
      this.emit('status');
      return;
    }
    if (!['set', 'get'].includes(kind)) return;
    const session = this.session;
    if (frame.version !== '1.0') return this.reply(kind, frame.id, 400, 'INVALID_VERSION', session);
    if (kind === 'get') {
      if (!Array.isArray(frame.params) || !frame.params.length || frame.params.length > FIELDS.length || frame.params.some(key => !FIELDS.includes(key)))
        return this.reply(kind, frame.id, 400, 'INVALID_PROPERTIES', session);
      const snapshot = this.snapshot?.();
      const available = snapshot?.online && !snapshot.simulation ? oneNetProperties(snapshot.data, snapshot.receivedAt, this.now()) : {};
      if (frame.params.some(key => !Object.hasOwn(available, key))) return this.reply(kind, frame.id, 503, 'PROPERTY_UNAVAILABLE', session);
      return this.reply(kind, frame.id, 200, 'success', session, Object.fromEntries(frame.params.map(key => [key, available[key]])));
    }
    const params = frame.params;
    if (!params || Array.isArray(params) || typeof params !== 'object' || Object.keys(params).length !== 1 || !Object.hasOwn(params, 'tiltAngle'))
      return this.reply(kind, frame.id, 400, 'READ_ONLY_OR_UNKNOWN_PROPERTY', session);
    if (!Number.isInteger(params.tiltAngle) || params.tiltAngle < 0 || params.tiltAngle > 90)
      return this.reply(kind, frame.id, 400, 'OUT_OF_RANGE', session);
    if (!this.command) return this.reply(kind, frame.id, 503, 'DEVICE_OFFLINE', session);
    let timer;
    try {
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 4200); });
      const ack = await Promise.race([this.command(frame.id, params.tiltAngle), timeout]);
      const applied = ack?.accepted === true && ack?.applied === true;
      const reason = /^[A-Z_]{1,48}$/.test(ack?.reason || '') ? ack.reason : 'NO_ACK_TIMEOUT';
      return await this.reply(kind, frame.id, applied ? 200 : 503, applied ? 'success' : reason, session);
    } catch { return await this.reply(kind, frame.id, 503, 'COMMAND_FAILED', session); }
    finally { clearTimeout(timer); }
  }
  async close() {
    this.stopped = true;
    this.ready = false;
    clearInterval(this.timer);
    clearTimeout(this.renewTimer);
    await this.client.endAsync(true);
  }
}
