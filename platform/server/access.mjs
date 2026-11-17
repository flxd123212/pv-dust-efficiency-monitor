import { isIP } from 'node:net';

export function accessInfo({ interfaces, host, port, publicUrl = '', now = Date.now() }) {
  const addresses = [];
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
        addresses.push({ name: 'HTTPS / HTTP', url: url.origin + '/', scope: 'public' });
    } catch { /* Ignore an invalid advertised URL; never encode credentials. */ }
  }
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    for (const [name, items] of Object.entries(interfaces)) {
      if (/vmware|virtualbox|vbox|vethernet|hyper-v|docker|loopback/i.test(name)) continue;
      for (const item of items || []) {
        const address = item.address;
        if (item.internal || isIP(address) !== 4 || /^(0\.|127\.|169\.254\.)/.test(address) || Number(address.split('.')[0]) >= 224) continue;
        if (!['0.0.0.0', '::', address, '::ffff:' + address].includes(host)) continue;
        const url = `http://${address}:${port}/`;
        if (!addresses.some(entry => entry.url === url)) addresses.push({ name, url, scope: 'lan' });
      }
    }
  }
  addresses.sort((a, b) => (a.scope === 'public' ? -2 : /wlan|wi-fi|wifi|wireless|无线/i.test(a.name) ? -1 : 0)
    - (b.scope === 'public' ? -2 : /wlan|wi-fi|wifi|wireless|无线/i.test(b.name) ? -1 : 0));
  return { addresses, updatedAt: now };
}
