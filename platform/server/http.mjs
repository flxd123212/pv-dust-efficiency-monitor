import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { listPorts } from './transport.mjs';
import { accessInfo } from './access.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
export function createWebServer({ hub, password, publicUrl = '', dist, onPortChanged = async () => {}, getNetworkInterfaces = networkInterfaces }) {
  const salt = randomBytes(16);
  const passwordHash = scryptSync(password, salt, 32);
  const sessions = new Map(), attempts = new Map(), commandRates = new Map(), streams = new Map();
  const ttl = 8 * 3600000;
  const secure = publicUrl.startsWith('https://');
  const headers = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {})
  };
  const cookieToken = req => /(?:^|;\s*)pv_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const validSession = token => Boolean(token && sessions.get(token) > Date.now());
  function json(res, code, body) { res.writeHead(code, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON_REQUIRED');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const fail = (res, status, reason) => json(res, status, { error: reason });
  function allowedOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try { return req.headers.origin === publicUrl || new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }
  function limited(map, key, limit, span = 60000) {
    const now = Date.now(), current = map.get(key);
    if (!current || current.until <= now) { map.set(key, { count: 1, until: now + span }); return false; }
    current.count++;
    return current.count > limit;
  }
  function broadcast(kind, data) {
    const bytes = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, token] of streams) {
      if (!validSession(token) || res.destroyed || !res.write(bytes)) { streams.delete(res); res.end(); }
    }
  }
  const listeners = Object.fromEntries(['data', 'status', 'ack'].map(kind => [kind, data => broadcast(kind, data)]));
  for (const [kind, listener] of Object.entries(listeners)) hub.on(kind, listener);
  const keepalive = setInterval(() => {
    for (const [token, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(token);
    for (const map of [attempts, commandRates]) for (const [key, item] of map) if (item.until <= Date.now()) map.delete(key);
    for (const [res, token] of streams) { if (!validSession(token)) { res.end(); streams.delete(res); } else res.write(': heartbeat\n\n'); }
  }, 15000);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (req.method === 'GET' && route === '/health') return json(res, 200, { service: 'pv-monitor', ready: true });
      if (req.method !== 'GET' && req.method !== 'HEAD' && !allowedOrigin(req)) return fail(res, 403, 'ORIGIN_REJECTED');
      const token = cookieToken(req);
      if (req.method === 'POST' && route === '/api/login') {
        const address = req.socket.remoteAddress;
        if (attempts.size > 512 || limited(attempts, address, 8)) return fail(res, 429, 'RATE_LIMITED');
        const input = await body(req);
        if (typeof input.password !== 'string' || input.password.length > 256 || !timingSafeEqual(scryptSync(input.password, salt, 32), passwordHash)) return fail(res, 401, 'INVALID_PASSWORD');
        if (sessions.size >= 100) return fail(res, 429, 'RATE_LIMITED');
        const created = randomBytes(32).toString('hex');
        sessions.set(created, Date.now() + ttl);
        res.setHeader('Set-Cookie', `pv_session=${created}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl / 1000}${secure ? '; Secure' : ''}`);
        return json(res, 200, { authenticated: true });
      }
      if (route.startsWith('/api/')) {
        if (!validSession(token)) return fail(res, 401, 'AUTH_REQUIRED');
        if (req.method === 'POST' && route === '/api/logout') {
          sessions.delete(token);
          for (const [stream, owner] of streams) if (owner === token) { stream.end(); streams.delete(stream); }
          res.setHeader('Set-Cookie', `pv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
          return json(res, 200, { authenticated: false });
        }
        if (req.method === 'GET' && route === '/api/session') return json(res, 200, { authenticated: true });
        if (req.method === 'GET' && route === '/api/access') {
          const bound = server.address();
          return json(res, 200, accessInfo({ interfaces: getNetworkInterfaces(), host: bound?.address, port: bound?.port, publicUrl }));
        }
        if (req.method === 'GET' && route === '/api/state') return json(res, 200, hub.snapshot());
        if (req.method === 'GET' && route === '/api/events') {
          if (streams.size >= 64) return fail(res, 429, 'TOO_MANY_STREAMS');
          res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`event: snapshot\ndata: ${JSON.stringify(hub.snapshot())}\n\n`);
          streams.set(res, token);
          req.on('close', () => streams.delete(res));
          return;
        }
        if (req.method === 'POST' && route === '/api/command') {
          if (limited(commandRates, token, 60)) return fail(res, 429, 'RATE_LIMITED');
          const input = await body(req);
          const ack = await hub.command(input);
          return json(res, ack.reason === 'DEVICE_OFFLINE' ? 503 : 200, ack);
        }
        if (req.method === 'GET' && (route === '/api/history' || route === '/api/export.csv')) {
          const hours = Number(url.searchParams.get('hours') || 1);
          if (!Number.isFinite(hours) || hours < 1 || hours > 168) return fail(res, 400, 'OUT_OF_RANGE');
          const rows = hub.store.history(hours);
          if (route.endsWith('.csv')) {
            const columns = ['current', 'panelTemp', 'rain', 'dustLevel', 'tiltAngle', 'targetAngle', 'cleaning', 'mode', 'quality', 'validFlags', 'temperatureStatus', 'adcCurrent', 'adcVoltage', 'temperatureRaw'];
            const lines = ['time,' + columns.join(','), ...rows.map(row => [new Date(row.at).toISOString(), ...columns.map(k => row[k])].join(','))];
            res.writeHead(200, { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=pv-history.csv', 'Cache-Control': 'no-store' });
            return res.end('\uFEFF' + lines.join('\r\n'));
          }
          return json(res, 200, rows);
        }
        if (req.method === 'GET' && route === '/api/logs') return json(res, 200, hub.store.logs());
        if (req.method === 'GET' && route === '/api/ports') return json(res, 200, hub.role === 'gateway' && !hub.simulation ? await listPorts() : []);
        if (req.method === 'POST' && route === '/api/connection') {
          if (hub.role !== 'gateway' || hub.simulation) return fail(res, 409, 'NOT_SERIAL_GATEWAY');
          const input = await body(req);
          if (typeof input.port !== 'string' || input.port.length > 128 || Object.keys(input).length !== 1) return fail(res, 400, 'INVALID_PORT');
          hub.failPending('CONNECTION_CHANGED');
          hub.data = null;
          hub.receivedAt = 0;
          await hub.transport.setPort(input.port);
          await onPortChanged(input.port);
          return json(res, 200, hub.snapshot());
        }
        return fail(res, 404, 'NOT_FOUND');
      }
      if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'METHOD_NOT_ALLOWED');
      const relative = decodeURIComponent(route === '/' ? '/index.html' : route);
      const file = path.resolve(dist, '.' + relative);
      if (file !== path.resolve(dist) && !file.startsWith(path.resolve(dist) + path.sep)) return fail(res, 403, 'FORBIDDEN');
      try {
        const info = await stat(file);
        if (!info.isFile()) return fail(res, 404, 'NOT_FOUND');
        const bytes = await readFile(file);
        res.writeHead(200, { ...headers, 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': route.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch { fail(res, 404, 'NOT_FOUND'); }
    } catch (error) {
      if (res.headersSent) return res.end();
      const safe = ['INVALID_COMMAND', 'OUT_OF_RANGE', 'PORT_NOT_FOUND', 'JSON_REQUIRED', 'BODY_TOO_LARGE'].includes(error.message) ? error.message : 'INVALID_REQUEST';
      fail(res, 400, safe);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  const close = async () => {
    clearInterval(keepalive);
    for (const [kind, listener] of Object.entries(listeners)) hub.off(kind, listener);
    for (const res of streams.keys()) res.end();
    streams.clear();
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  };
  return { server, close };
}
