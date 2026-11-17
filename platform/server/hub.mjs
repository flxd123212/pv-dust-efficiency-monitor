import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { validateCommand, validateData, validateAck, ID_PATTERN, rejection } from './contract.mjs';

export class Hub extends EventEmitter {
  constructor({ store, transport, role = 'gateway', deviceId = 'PV01', simulation = false, retryMs = 1200 }) {
    super();
    Object.assign(this, { store, transport, role, deviceId, simulation, retryMs });
    this.data = null;
    this.receivedAt = 0;
    this.pending = new Map();
    this.lastOnline = false;
    this.transport.on('data', frame => this.ingest(frame));
    this.transport.on('ack', ack => this.acknowledge(ack));
    this.transport.on('status', () => this.status());
    this.transport.on('command', cmd => this.external(cmd));
    this.timer = setInterval(() => this.status(), 1000);
  }
  online() { return Boolean(this.transport.connected && this.data && Date.now() - this.receivedAt < 5000); }
  snapshot() {
    return { deviceId: this.deviceId, role: this.role, simulation: this.simulation, online: this.online(),
      receivedAt: this.receivedAt || null, data: this.data, connection: this.transport.status(), pending: this.pending.size };
  }
  status() {
    const online = this.online();
    if (online !== this.lastOnline) {
      this.lastOnline = online;
      this.transport.presence?.(online);
      if (!online) this.failPending('DEVICE_OFFLINE');
    }
    this.emit('status', this.snapshot());
  }
  ingest(frame) {
    const data = validateData(frame);
    if (!data) return false;
    if (this.data && data.seq === this.data.seq && data.uptimeS === this.data.uptimeS) return false;
    if (this.data && data.seq < this.data.seq && data.uptimeS < this.data.uptimeS) this.failPending('DEVICE_REBOOTED');
    this.data = data;
    this.receivedAt = Date.now();
    this.store.sample(data, this.receivedAt);
    this.transport.upstream?.('data', { ...data, sentAt: this.receivedAt });
    this.emit('data', this.snapshot());
    this.status();
    return true;
  }
  acknowledge(ack) {
    if (!validateAck(ack)) return false;
    const entry = this.pending.get(ack.cmdId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(ack.cmdId);
    this.store.complete(ack);
    this.transport.upstream?.('ack', ack);
    this.emit('ack', ack);
    entry.resolve(ack);
    return true;
  }
  failPending(reason) {
    for (const id of [...this.pending.keys()]) this.finish(id, rejection(id, reason));
  }
  finish(id, ack) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.store.complete(ack);
    this.transport.upstream?.('ack', ack);
    this.emit('ack', ack);
    entry.resolve(ack);
  }
  async command(input, envelope = null) {
    const body = validateCommand(input);
    const cmd = envelope || { type: 'cmd', cmdId: randomBytes(16).toString('hex'), issuedAt: Date.now(), ...body };
    if (this.pending.has(cmd.cmdId)) {
      const pending = this.pending.get(cmd.cmdId);
      return JSON.stringify(pending.cmd) === JSON.stringify(cmd) ? pending.promise : rejection(cmd.cmdId, 'ID_CONFLICT');
    }
    const prior = this.store.command(cmd.cmdId);
    if (prior) return JSON.stringify(prior.command) === JSON.stringify(cmd) ? prior.ack || rejection(cmd.cmdId, 'SERVER_RESTARTED') : rejection(cmd.cmdId, 'ID_CONFLICT');
    this.store.requested(cmd);
    const reject = reason => {
      const ack = rejection(cmd.cmdId, reason);
      this.store.complete(ack);
      this.transport.upstream?.('ack', ack);
      this.emit('ack', ack);
      return ack;
    };
    if (!this.online()) return reject('DEVICE_OFFLINE');
    if (body.action === 'resume' && !Object.hasOwn(this.data, 'motionPaused'))
      return reject('FIRMWARE_UPDATE_REQUIRED');
    if (body.action === 'pirAlarm' && !Object.hasOwn(this.data, 'pirAlarmEnabled'))
      return reject('FIRMWARE_UPDATE_REQUIRED');
    if (this.data.protocol < 3 && ['clean', 'mode', 'baseline'].includes(body.action) && body.value)
      return reject('FIRMWARE_UPDATE_REQUIRED');
    if (this.pending.size >= 4) return reject('BUSY');
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const entry = { cmd, resolve, promise, tries: 0, timer: null };
    this.pending.set(cmd.cmdId, entry);
    const transmit = () => {
      if (!this.pending.has(cmd.cmdId)) return;
      if (!this.online()) return this.finish(cmd.cmdId, rejection(cmd.cmdId, 'DEVICE_OFFLINE'));
      if (entry.tries >= 3) return this.finish(cmd.cmdId, rejection(cmd.cmdId, 'NO_ACK_TIMEOUT'));
      entry.tries++;
      entry.timer = setTimeout(transmit, this.retryMs);
      try {
        Promise.resolve(this.transport.send(cmd)).catch(() => this.finish(cmd.cmdId, rejection(cmd.cmdId, 'TRANSPORT_ERROR')));
      } catch { this.finish(cmd.cmdId, rejection(cmd.cmdId, 'TRANSPORT_ERROR')); }
    };
    transmit();
    return promise;
  }
  async external(cmd) {
    if (!cmd || !ID_PATTERN.test(cmd.cmdId) || cmd.type !== 'cmd') return;
    if (!Number.isSafeInteger(cmd.issuedAt) || Math.abs(Date.now() - cmd.issuedAt) > 10000) {
      this.transport.upstream?.('ack', rejection(cmd.cmdId, 'STALE_COMMAND'));
      return;
    }
    const { type, cmdId, issuedAt, ...body } = cmd;
    try {
      const ack = await this.command(body, { type, cmdId, issuedAt, ...validateCommand(body) });
      this.transport.upstream?.('ack', ack);
    } catch { this.transport.upstream?.('ack', rejection(cmdId, 'INVALID_COMMAND')); }
  }
  async close() {
    clearInterval(this.timer);
    this.failPending('SERVER_STOPPING');
    await this.transport.close();
  }
}
