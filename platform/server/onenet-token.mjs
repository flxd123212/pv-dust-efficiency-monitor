import { createHmac } from 'node:crypto';

export const ONENET_TOKEN_TTL_S = 24 * 60 * 60;

export function makeOneNetToken({ productId, deviceName, deviceKey, expiresAt, method = 'sha256' }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId || '') || !/^[A-Za-z0-9_.:-]{1,64}$/.test(deviceName || ''))
    throw new Error('Invalid OneNET product ID or device name');
  if (!['sha1', 'sha256'].includes(method) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    throw new Error('Invalid OneNET token parameters');
  if (typeof deviceKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(deviceKey) || deviceKey.length % 4)
    throw new Error('OneNET device key must be Base64');
  const key = Buffer.from(deviceKey, 'base64');
  if (key.length < 16 || key.toString('base64') !== deviceKey) throw new Error('Invalid OneNET device key');
  const version = '2018-10-31';
  const resource = `products/${productId}/devices/${deviceName}`;
  const signature = createHmac(method, key).update(`${expiresAt}\n${method}\n${resource}\n${version}`, 'utf8').digest('base64');
  return `version=${version}&res=${encodeURIComponent(resource)}&et=${expiresAt}&method=${method}&sign=${encodeURIComponent(signature)}`;
}
