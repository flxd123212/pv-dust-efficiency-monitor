import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from './store.mjs';
import { Hub } from './hub.mjs';
import { SerialTransport, CloudTransport, MqttLink, Simulator } from './transport.mjs';
import { createWebServer } from './http.mjs';
import { DEVICE_PATTERN } from './contract.mjs';
import { OneNetLink, bindOneNetHub } from './onenet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const role = process.env.PV_ROLE || 'gateway';
const deviceId = process.env.PV_DEVICE_ID || 'PV01';
const simulation = process.env.PV_SIMULATE === '1';
const provider = process.env.PV_CLOUD_PROVIDER || 'mqtt';
const dataDir = path.resolve(process.env.PV_DATA_DIR || path.join(root, 'data'));
if (!['gateway', 'cloud'].includes(role) || !DEVICE_PATTERN.test(deviceId)) throw new Error('Invalid role or device ID');
if (simulation && role === 'cloud') throw new Error('Simulation must not publish to a production cloud');
if (!['mqtt', 'onenet'].includes(provider)) throw new Error('Invalid PV_CLOUD_PROVIDER');
if (provider === 'onenet' && (simulation || role !== 'gateway')) throw new Error('OneNET requires a real serial gateway, not simulation or cloud mode');
await mkdir(dataDir, { recursive: true });
let password = process.env.PV_PASSWORD;
if (!password && role === 'cloud') throw new Error('PV_PASSWORD is required for cloud deployment');
if (!password) {
  const secretFile = path.join(dataDir, 'admin.secret');
  try { password = (await readFile(secretFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    password = 'pv-' + randomBytes(15).toString('base64url');
    await writeFile(secretFile, password + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(`Local login password file: ${secretFile}`);
}
if (password.length < 12 || password.length > 256) throw new Error('PV_PASSWORD must contain 12 to 256 characters');
let config = {};
const configFile = path.join(dataDir, 'gateway.json');
try { config = JSON.parse(await readFile(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const link = provider === 'onenet' ? new OneNetLink({ productId: process.env.PV_ONENET_PRODUCT_ID,
  deviceName: process.env.PV_ONENET_DEVICE_NAME, deviceKey: process.env.PV_ONENET_DEVICE_KEY,
  reportMs: Number(process.env.PV_ONENET_REPORT_MS || 5000) }) : simulation ? null : new MqttLink({ url: process.env.PV_MQTT_URL, username: process.env.PV_MQTT_USERNAME,
  password: process.env.PV_MQTT_PASSWORD, deviceId, role, allowInsecure: process.env.PV_ALLOW_INSECURE_MQTT === '1' });
const transport = simulation ? new Simulator() : role === 'cloud' ? new CloudTransport(link) : new SerialTransport({ path: process.env.PV_SERIAL_PORT ?? config.port ?? '', link });
const store = new Store(path.join(dataDir, simulation ? 'simulation.sqlite3' : 'pv.sqlite3'));
const hub = new Hub({ store, transport, role, deviceId, simulation });
if (provider === 'onenet') bindOneNetHub(link, hub);
const web = createWebServer({ hub, password, publicUrl: process.env.PV_PUBLIC_URL || '', dist: path.join(root, 'dist'),
  onPortChanged: port => writeFile(configFile, JSON.stringify({ port }, null, 2), { mode: 0o600 }) });
const port = Number(process.env.PV_PORT || 8787);
const host = process.env.PV_HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PV_PORT');
web.server.listen(port, host, () => {
  console.log(`PV Monitor ${role}${simulation ? ' [SIMULATION]' : ''}: http://localhost:${port}`);
  if (host === '0.0.0.0') for (const nic of Object.values(networkInterfaces()).flat())
    if (nic.family === 'IPv4' && !nic.internal) console.log(`LAN: http://${nic.address}:${port}`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await web.close();
  await hub.close();
  store.close();
}
process.on('SIGINT', () => stop().then(() => process.exit(0)));
process.on('SIGTERM', () => stop().then(() => process.exit(0)));
web.server.on('error', async error => { console.error(error.message); await hub.close(); store.close(); process.exit(1); });
