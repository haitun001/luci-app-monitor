'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
	'../htdocs/luci-static/resources/view/status/monitor.js'), 'utf8');
const context = vm.createContext({
	rpc: { declare: () => () => {} },
	L: { toArray: value => value == null ? [] : [].concat(value), naturalCompare: (a, b) => a.localeCompare(b) },
	uci: { sections: () => [ { name: 'wan', network: [ 'wan', 'wan2', 'modem' ] } ],
		get: (config, name) => name == 'modem' ? '0' : null },
	// LuCI owns address parsing; the browser suite exercises its real IPv6 parser.
	validation: { parseIPv4: text => {
		const parts = text.split('.').map(Number);
		return /^\d+\.\d+\.\d+\.\d+$/.test(text) && parts.every(n => n >= 0 && n <= 255) ? parts : null;
	}, parseIPv6: () => null }
});
vm.runInContext(source.slice(0, source.indexOf('return view.extend')), context);

const interfaces = [
	{ interface: 'lan', up: true, device: 'br-lan' },
	{ interface: 'guest', up: true, device: 'br-guest' },
	{ interface: 'wan', up: true, device: 'eth4', l3_device: 'pppoe-wan' },
	{ interface: 'wan6', up: false, device: 'eth4' },
	{ interface: 'wan2', up: true, device: 'eth5' },
	{ interface: 'modem', up: true, device: 'eth6' }
];
const device = (ip, mask = '255.255.255.0') => ({ up: true,
	stats: { rx_bytes: 1000, tx_bytes: 2000 }, ipaddrs: ip ? [ { address: ip, netmask: mask } ] : [] });
const devices = {
	'br-lan': device('192.168.1.1'), 'br-guest': device('192.168.2.1'),
	eth4: device('192.168.100.2'), 'pppoe-wan': device('203.0.113.2', '255.255.255.255'),
	eth5: device('198.51.100.2'), eth6: device('192.168.200.2'),
	eth0: device(), eth1: { ...device(), up: false }
};
const definitions = context.lineDefinitions(interfaces, devices);
const wan = context.wanDevices(interfaces, devices, definitions.groups);
assert.deepEqual(Array.from(wan.names), [ 'eth4', 'eth5' ], 'Connected WANs do not require default routes');

const flow = (src, dst, replySrc = dst, replyDst = src) =>
	`ipv4 2 tcp 6 120 TIME_WAIT src=${src} dst=${dst} sport=12345 dport=443 ` +
	`src=${replySrc} dst=${replyDst} sport=443 dport=12345 mark=0 use=1\n`;
const nat = flow('192.168.1.10', '8.8.8.8', '8.8.8.8', '203.0.113.2');
function counts(text, topology = definitions, counters = devices) {
	const result = context.connectionCounts(text, topology.lines, counters, wan);
	return Object.fromEntries(topology.lines.map(line => [ line.device, result[line.key] ]));
}
let result = counts(nat);
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, 1, 'Upper PPP address maps to the physical WAN row');
assert.equal(result.eth5, 0);
assert.equal(result.eth0, null, 'Unaddressed bridge ports are not assigned bridge counts');
assert.equal(result.eth1, 0);
assert.equal(definitions.lines.filter(line => line.device == 'eth4').length, 1);

result = counts(flow('9.9.9.9', '203.0.113.2', '192.168.1.20', '9.9.9.9'));
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, 1, 'Inbound DNAT belongs to both the WAN and destination LAN');

result = counts(flow('192.168.1.10', '203.0.113.2', '192.168.1.20', '192.168.1.1'));
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, 0, 'Hairpin NAT does not traverse the public WAN');

result = counts(flow('192.168.1.10', '192.168.2.20'));
assert.equal(result['br-lan'], 1);
assert.equal(result['br-guest'], 1);
assert.equal(result.eth4, 0);
assert.equal(counts(flow('192.168.1.10', '192.168.1.1')).eth4, 0);

result = counts(flow('192.168.1.10', '8.8.8.8'));
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, null, 'Untranslated forwarding cannot be assigned to a WAN by guessing');
assert.equal(result.eth5, null);

const overlapping = { ...devices, extra: device('192.168.1.2') };
result = counts(nat, context.lineDefinitions(interfaces, overlapping), overlapping);
assert.equal(result['br-lan'], null);
assert.equal(result.extra, null);

assert.equal(counts('').eth4, 0);
for (const invalid of [ null, 'truncated', nat.slice(0, 80), nat + 'malformed\n',
	flow('999.168.1.10', '8.8.8.8') ]) {
	result = counts(invalid);
	assert.equal(result['br-lan'], null);
	assert.equal(result.eth4, null);
	assert.equal(result.eth1, 0);
}
const large = nat.repeat(5000);
assert(large.length > 256 * 1024);
assert.equal(counts(large).eth4, 5000);
assert.equal(counts(large)['br-lan'], 5000);

const down = interfaces.map(info => ({ ...info, up: false }));
assert.equal(context.wanDevices(down, devices, context.lineDefinitions(down, devices).groups).names.length, 0);
const sample = context.rates(null, { rx: 100, tx: 100 }, 'eth4', 1000).sample;
assert.equal(context.rates(sample, { rx: 90, tx: 200 }, 'eth4', 2000).rx, 0);
assert.equal(context.rates(sample, { rx: 110, tx: 200 }, 'eth4', 1000).rx, 0);
console.log('Monitor checks passed: connection attribution, ambiguity, malformed/large data, WAN eligibility, counter resets');
