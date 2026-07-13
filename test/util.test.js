'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ipToInt, isIPv4, ipInNetwork, normalizeWarehouseIds } = require('../lib/util');

test('isIPv4', () => {
  assert.strictEqual(isIPv4('192.168.0.1'), true);
  assert.strictEqual(isIPv4('10.0.0.255'), true);
  assert.strictEqual(isIPv4('::1'), false);
  assert.strictEqual(isIPv4('abc'), false);
});

test('ipToInt', () => {
  assert.strictEqual(ipToInt('0.0.0.0'), 0);
  assert.strictEqual(ipToInt('255.255.255.255'), 4294967295);
  assert.strictEqual(ipToInt('192.168.1.1'), 3232235777);
});

test('ipInNetwork: exact match', () => {
  assert.strictEqual(ipInNetwork('1.2.3.4', '1.2.3.4'), true);
  assert.strictEqual(ipInNetwork('1.2.3.4', '1.2.3.5'), false);
});

test('ipInNetwork: CIDR /24', () => {
  assert.strictEqual(ipInNetwork('192.168.1.10', '192.168.1.0/24'), true);
  assert.strictEqual(ipInNetwork('192.168.2.10', '192.168.1.0/24'), false);
});

test('ipInNetwork: CIDR /16 and /0', () => {
  assert.strictEqual(ipInNetwork('10.5.9.9', '10.5.0.0/16'), true);
  assert.strictEqual(ipInNetwork('10.6.0.1', '10.5.0.0/16'), false);
  assert.strictEqual(ipInNetwork('8.8.8.8', '0.0.0.0/0'), true);
});

test('ipInNetwork: invalid prefix / empty', () => {
  assert.strictEqual(ipInNetwork('1.2.3.4', '1.2.3.0/33'), false);
  assert.strictEqual(ipInNetwork('1.2.3.4', ''), false);
});

test('normalizeWarehouseIds: array of numbers', () => {
  assert.deepStrictEqual(normalizeWarehouseIds([1, 3, 3, 5], null), ['1', '3', '5']);
});

test('normalizeWarehouseIds: CSV string', () => {
  assert.deepStrictEqual(normalizeWarehouseIds('2, 4 ,4', null), ['2', '4']);
});

test('normalizeWarehouseIds: fallback to single warehouseId', () => {
  assert.deepStrictEqual(normalizeWarehouseIds(undefined, 7), ['7']);
  assert.deepStrictEqual(normalizeWarehouseIds([], null), []);
});

test('normalizeWarehouseIds: rejects non-numeric', () => {
  assert.deepStrictEqual(normalizeWarehouseIds(['1', 'x', '', '2'], null), ['1', '2']);
});
