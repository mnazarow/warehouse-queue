// Чистые функции без побочных эффектов — вынесены из server.js, чтобы их можно
// было переиспользовать и покрыть автотестами (test/util.test.js).
'use strict';

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIPv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

// Проверяет, входит ли IPv4-адрес в сеть (точный адрес или CIDR a.b.c.d/n).
// Для IPv6/смешанных случаев — только точное совпадение.
function ipInNetwork(clientIP, network) {
  if (!network) return false;
  if (network.includes('/')) {
    const [netIP, prefixStr] = network.split('/');
    if (!isIPv4(clientIP) || !isIPv4(netIP)) return clientIP === netIP;
    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (~(2 ** (32 - prefix) - 1)) >>> 0;
    return ((ipToInt(clientIP) & mask) >>> 0) === ((ipToInt(netIP) & mask) >>> 0);
  }
  return clientIP === network;
}

// Нормализует список складов менеджера в массив числовых id-строк (без дублей).
function normalizeWarehouseIds(warehouseIds, warehouseId) {
  let arr = [];
  if (Array.isArray(warehouseIds)) arr = warehouseIds;
  else if (typeof warehouseIds === 'string' && warehouseIds) arr = warehouseIds.split(',');
  else if (warehouseId != null && warehouseId !== '') arr = [warehouseId];
  const out = [];
  for (let v of arr) {
    v = String(v).trim();
    if (v && /^\d+$/.test(v) && out.indexOf(v) === -1) out.push(v);
  }
  return out;
}

module.exports = { ipToInt, isIPv4, ipInNetwork, normalizeWarehouseIds };
