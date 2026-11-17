import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOneNetToken, ONENET_TOKEN_TTL_S } from '../server/onenet-token.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expiresAt = Math.floor(Date.now() / 1000) + ONENET_TOKEN_TTL_S;
const token = makeOneNetToken({ productId: process.env.PV_ONENET_PRODUCT_ID,
  deviceName: process.env.PV_ONENET_DEVICE_NAME, deviceKey: process.env.PV_ONENET_DEVICE_KEY, expiresAt });
const directory = path.resolve(process.env.PV_DATA_DIR || path.join(root, 'data'));
await mkdir(directory, { recursive: true });
const destination = path.join(directory, 'onenet-token.secret');
await writeFile(destination, token + '\n', { mode: 0o600 });
console.log(`Token saved locally: ${destination}`);
console.log(`Expires: ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(expiresAt * 1000)} (Asia/Shanghai)`);
console.log('Use the file contents as MQTT password. Do not publish it or connect a second client with the same device name.');
