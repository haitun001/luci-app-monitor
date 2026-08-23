'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const baseUrl = process.env.MONITOR_ROUTER_URL;
const username = process.env.MONITOR_ROUTER_USER || 'root';
const password = process.env.MONITOR_ROUTER_PASSWORD;
const chromePath = process.env.MONITOR_CHROME_PATH;
const outputDir = process.env.MONITOR_OUTPUT_DIR;
const soakMinutes = Number(process.env.MONITOR_SOAK_MINUTES || 8);

for (const [ name, value ] of Object.entries({ baseUrl, password, chromePath, outputDir }))
	assert(value, `Missing required environment value: ${name}`);

fs.mkdirSync(outputDir, { recursive: true });

const results = {
	consoleErrors: [],
	pageErrors: [],
	screenshots: [],
	soakMinutes
};

function calls(body) {
	try {
		return [].concat(JSON.parse(body || '[]'));
	}
	catch (e) {
		return [];
	}
}

function watch(page) {
	const polls = [], sensorRequests = [], sensorReplies = [];

	page.on('console', message => {
		if (message.type() === 'error')
			results.consoleErrors.push(message.text());
	});
	page.on('pageerror', error => results.pageErrors.push(error.message));
	page.on('request', request => {
		const batch = calls(request.postData());
		if (batch.some(call => call.params?.[1] === 'system' && call.params?.[2] === 'info'))
			polls.push(Date.now());
		if (batch.some(call => call.params?.[1] === 'file' && call.params?.[2] === 'exec' &&
			call.params?.[3]?.command === '/usr/sbin/sensors' &&
			JSON.stringify(call.params?.[3]?.params) === JSON.stringify([ '-j', '-A' ])))
			sensorRequests.push(Date.now());
	});
	page.on('response', async response => {
		const batch = calls(response.request().postData());
		const sensorCall = batch.find(call => call.params?.[1] === 'file' && call.params?.[2] === 'exec');
		if (!sensorCall)
			return;

		try {
			const replies = [].concat(await response.json());
			sensorReplies.push(replies.find(reply => reply.id === sensorCall.id));
		}
		catch (e) {
			sensorReplies.push(null);
		}
	});

	return { polls, sensorRequests, sensorReplies };
}

async function login(page) {
	await page.goto(`${baseUrl}/cgi-bin/luci/admin/status/monitor`, { waitUntil: 'domcontentloaded' });
	const passwordInput = page.locator('input[name="luci_password"]');

	if (await passwordInput.count()) {
		await page.locator('input[name="luci_username"]').fill(username);
		await passwordInput.fill(password);
		await passwordInput.press('Enter');
	}

	await page.waitForURL(/\/admin\/status\/monitor/, { timeout: 15000 });
	await page.locator('h2').waitFor({ state: 'visible' });
	results.consoleErrors.length = 0;
	results.pageErrors.length = 0;
}

async function screenshot(page, name) {
	const file = path.join(outputDir, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	results.screenshots.push(file);
}

async function smoke(browser, locale, viewport, expectedTitle, expectedHeaders, name) {
	const context = await browser.newContext({ locale, viewport });
	const page = await context.newPage();
	watch(page);
	await login(page);
	await page.waitForTimeout(6000);
	assert.equal((await page.locator('h2').innerText()).trim(), expectedTitle);
	const table = page.locator('table').nth(1);
	const labels = (await table.locator('tbody tr td:first-child').allTextContents()).map(value => value.trim());
	assert(labels.length > 1);
	assert.equal(new Set(labels).size, labels.length);
	assert(labels.some(label => label.includes('(br-lan)')));
	assert(labels.some(label => label.includes('(eth4)') && /(?:^|\/)wan(?:\/| )/.test(label)));
	assert.deepEqual((await table.locator('thead th').allTextContents()).map(value => value.trim()), expectedHeaders);
	assert.equal(await table.locator('tbody tr td[data-title]').count(), labels.length * 7);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	assert.equal(results.consoleErrors.length, 0);
	assert.equal(results.pageErrors.length, 0);
	await screenshot(page, name);
	await context.close();
}

function rateInMiB(text) {
	const match = /^(\d+\.\d{2}) (KB|MB|GB)\/s$/.exec(text);
	assert(match, `Invalid rate: ${text}`);
	return Number(match[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 })[match[2]];
}

async function trafficFixture(browser) {
	const MiB = 1024 ** 2;
	const GiB = 1024 ** 3;
	const interfaces = [
		{ interface: 'loopback', up: true, dynamic: false, uptime: 1100, device: 'lo', l3_device: 'lo', route: [] },
		{ interface: 'downlan', up: false, dynamic: false, device: 'br-down', l3_device: 'br-down', route: [] },
		{ interface: 'guest', up: true, dynamic: false, uptime: 980, device: 'br-guest', l3_device: 'br-guest', route: [] },
		{ interface: 'iot', up: true, dynamic: false, uptime: 970, device: 'eth2.100', l3_device: 'eth2.100', route: [] },
		{ interface: 'lan', up: true, dynamic: false, uptime: 1000, device: 'br-lan', l3_device: 'br-lan', route: [] },
		{ interface: 'modem', up: true, dynamic: false, uptime: 800, device: 'eth6', l3_device: 'eth6', route: [] },
		{ interface: 'vpn', up: true, dynamic: false, uptime: 700, device: 'tun0', l3_device: 'tun0', route: [] },
		{ interface: 'wan', up: true, dynamic: false, uptime: 900, device: 'eth4', l3_device: 'pppoe-wan', route: [
			{ target: '0.0.0.0', mask: 0 }
		] },
		{ interface: 'wan6', up: false, pending: true, dynamic: false, device: 'eth4' },
		{ interface: 'wan_6', up: true, dynamic: true, uptime: 880, device: 'pppoe-wan', l3_device: 'pppoe-wan',
			data: { zone: 'wan' }, route: [ { target: '::', mask: 0 } ] },
		{ interface: 'cell_4', up: true, dynamic: true, uptime: 870, device: 'eth7', l3_device: 'qmi-cell',
			data: { zone: 'wan' }, route: [ { target: '0.0.0.0', mask: 0 } ] },
		{ interface: 'wan2', up: true, dynamic: false, uptime: 860, device: 'eth5', l3_device: 'eth5',
			route: [ { target: '0.0.0.0', mask: 0 } ] },
		{ interface: 'wan2v6', up: true, dynamic: false, uptime: 850, device: 'eth5', l3_device: 'eth5',
			route: [ { target: '::', mask: 0 } ] },
		{ interface: 'wgwan', up: true, dynamic: false, uptime: 820, l3_device: 'wg0',
			route: [ { target: '0.0.0.0', mask: 0 } ] }
	];
	const networkValues = Object.fromEntries([
		'loopback', 'downlan', 'guest', 'iot', 'lan', 'modem', 'vpn',
		'wan', 'wan6', 'wan2', 'wan2v6', 'wgwan'
	].map(name => [ name, {
		'.anonymous': false,
		'.type': 'interface',
		'.name': name,
		proto: name === 'wan' ? 'pppoe' : 'static'
	} ]));
	networkValues.modem.defaultroute = '0';
	const firewallValues = {
		cfgwan: {
			'.anonymous': true,
			'.type': 'zone',
			'.name': 'cfgwan',
			name: 'wan',
			network: [ 'modem', 'wan2', 'wan2v6', 'wgwan' ],
			device: [ 'pppoe+', 'usb+', 'tun-raw', '!usb9' ]
		}
	};
	const expectedLabels = [
		'cell_4 (eth7)', 'downlan (br-down)', 'guest (br-guest)', 'iot (eth2.100)', 'lan (br-lan)',
		'modem (eth6)', 'vpn (tun0)', 'wan/wan6 (eth4)', 'wan2/wan2v6 (eth5)',
		'wgwan (wg0)', 'gre1', 'lan1', 'lan2', 'tap0', 'tun-raw', 'usb0', 'usb9', 'veth0'
	];
	const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	let sample = -1;
	let hotplug = false;
	let resetLan1 = false;
	let cpuMode = 'normal';
	let cpuReads = 0;
	const cpu = { user: 100, system: 100, idle: 800 };

	function cpuData() {
		cpuReads++;
		if (cpuMode === 'malformed')
			return 'cpu unavailable\n';
		if (cpuMode === 'reset') {
			Object.assign(cpu, { user: 10, system: 10, idle: 80 });
			cpuMode = 'normal';
		}

		const data = `cpu  ${cpu.user} 0 ${cpu.system} ${cpu.idle} 0 0 0 0 999 999\n` +
			`cpu0 1 0 1 98 0 0 0 0 0 0\ncpu1 99 0 99 702 0 0 0 0 0 0\n`;
		cpu.user += 10;
		cpu.system += 10;
		cpu.idle += 80;
		return data;
	}

	async function nextCPU(mode) {
		const before = cpuReads;
		cpuMode = mode;
		for (let i = 0; i < 50 && cpuReads === before; i++)
			await page.waitForTimeout(100);
		assert(cpuReads > before, 'Timed out waiting for CPU sample');
		await page.waitForTimeout(100);
	}

	await page.route('**/ubus/**', async route => {
		const batch = calls(route.request().postData());
		const response = await route.fetch();
		let reply = await response.json();
		const replies = [].concat(reply);
		let changed = false;

		if (batch.some(call => call.params?.[1] === 'luci-rpc' && call.params?.[2] === 'getNetworkDevices'))
			sample++;

		for (const call of batch) {
			const item = replies.find(candidate => candidate.id === call.id);
			if (!item)
				continue;

			const object = call.params?.[1];
			const method = call.params?.[2];
			const n = Math.max(sample, 0);

			if (object === 'uci' && method === 'get' && call.params?.[3]?.config === 'network') {
				item.result = [ 0, { values: networkValues } ];
				changed = true;
			}
			else if (object === 'uci' && method === 'get' && call.params?.[3]?.config === 'firewall') {
				item.result = [ 0, { values: firewallValues } ];
				changed = true;
			}
			else if (object === 'network.interface' && method === 'dump') {
				item.result = [ 0, { interface: interfaces } ];
				changed = true;
			}
			else if (object === 'luci-rpc' && method === 'getNetworkDevices') {
				const deviceData = {
					'br-down': { up: false, stats: { rx_bytes: 2 * GiB, tx_bytes: 512 * MiB } },
					'br-guest': { up: true, stats: { rx_bytes: 1 * GiB + n * MiB, tx_bytes: 3 * GiB + n * 4 * MiB } },
					'br-lan': { up: true, stats: { rx_bytes: 256 * MiB + n * 5 * MiB, tx_bytes: 8 * GiB + n * 20 * MiB } },
					'eth2.100': { up: true, stats: { rx_bytes: 700 * MiB + n * 2 * MiB, tx_bytes: 900 * MiB + n * 3 * MiB } },
					'eth4': { up: true, stats: { rx_bytes: 4 * GiB + n * 12 * MiB, tx_bytes: 512 * MiB + n * 3 * MiB } },
					'eth5': { up: true, stats: { rx_bytes: 6 * GiB + n * 6 * MiB, tx_bytes: 1 * GiB + n * 1.5 * MiB } },
					'eth6': { up: true, stats: { rx_bytes: 80 * GiB + n * 60 * MiB, tx_bytes: 40 * GiB + n * 30 * MiB } },
					'eth7': { up: true, stats: { rx_bytes: 2 * GiB + n * 9 * MiB, tx_bytes: 1 * GiB + n * 3 * MiB } },
					'gre0': { up: false, stats: { rx_bytes: 0, tx_bytes: 0 } },
					'gre1': { up: true, stats: { rx_bytes: 12 * MiB + n * MiB, tx_bytes: 9 * MiB + n * MiB } },
					'ifb0': { up: true, stats: { rx_bytes: 90 * GiB, tx_bytes: 90 * GiB } },
					'lan1': { up: true, stats: resetLan1
						? { rx_bytes: 2 * MiB, tx_bytes: MiB }
						: { rx_bytes: GiB + n * 2 * MiB, tx_bytes: 2 * GiB + n * MiB } },
					'lan2': { up: false, stats: { rx_bytes: 300 * MiB, tx_bytes: 600 * MiB } },
					'lo': { up: true, stats: { rx_bytes: 200 * GiB, tx_bytes: 200 * GiB } },
					'mon.wlan0': { up: true, stats: { rx_bytes: 90 * GiB, tx_bytes: 90 * GiB } },
					'pppoe-wan': { up: true, stats: { rx_bytes: 64 * GiB + n * 100 * MiB, tx_bytes: 32 * GiB + n * 50 * MiB } },
					'sit0': { up: false, stats: { rx_bytes: 0, tx_bytes: 0 } },
					'tap0': { up: true, stats: { rx_bytes: 20 * MiB + n * MiB, tx_bytes: 30 * MiB + n * MiB } },
					'tun0': { up: true, stats: { rx_bytes: 5 * GiB + n * 9 * MiB, tx_bytes: 2 * GiB + n * 6 * MiB } },
					'tun-raw': { up: true, flags: { pointtopoint: true },
						stats: { rx_bytes: 9 * GiB + n * 90 * MiB, tx_bytes: 8 * GiB + n * 45 * MiB } },
					'usb0': { up: true, stats: { rx_bytes: 3 * GiB + n * 3 * MiB, tx_bytes: 600 * MiB + n * 0.75 * MiB } },
					'usb9': { up: true, stats: { rx_bytes: 70 * GiB + n * 70 * MiB, tx_bytes: 60 * GiB + n * 60 * MiB } },
					'veth0': { up: true, stats: { rx_bytes: 40 * MiB + n * MiB, tx_bytes: 50 * MiB + n * MiB } },
					'wg0': { up: true, devtype: 'wireguard', stats: { rx_bytes: 100 * GiB + n * 90 * MiB, tx_bytes: 50 * GiB + n * 45 * MiB } },
					'wifi0': { up: true, stats: { rx_bytes: 90 * GiB, tx_bytes: 90 * GiB } }
				};
				if (hotplug)
					deviceData['tun-hot'] = { up: true, stats: { rx_bytes: n * MiB, tx_bytes: n * MiB } };
				item.result = [ 0, deviceData ];
				changed = true;
			}
			else if (object === 'system' && method === 'info') {
				item.result = [ 0, { localtime: 1787429279 + n * 5, memory: { total: 1024, free: 256 } } ];
				changed = true;
			}
			else if (object === 'file' && method === 'read' && call.params?.[3]?.path === '/proc/stat') {
				item.result = [ 0, { data: cpuData() } ];
				changed = true;
			}
			else if (object === 'file' && method === 'exec') {
				item.result = [ 0, { code: 0, stdout: '{}', stderr: '' } ];
				changed = true;
			}
		}

		if (changed)
			await route.fulfill({ response, body: JSON.stringify(Array.isArray(reply) ? replies : replies[0]) });
		else
			await route.fulfill({ response });
	});

	watch(page);
	await login(page);
	await page.waitForTimeout(6500);
	const tables = page.locator('table');
	const summary = (await tables.nth(0).locator('tbody tr td:last-child').allTextContents()).map(value => value.trim());
	const rows = await tables.nth(1).locator('tbody tr').evaluateAll(items => items.map(row =>
		Array.from(row.cells, cell => cell.textContent.trim())));
	const n = sample;
	const byLabel = Object.fromEntries(rows.map(row => [ row[0], row ]));

	assert.equal(summary[0], '20.00%');
	assert.deepEqual(rows.map(row => row[0]), expectedLabels);
	assert.equal(byLabel['downlan (br-down)'][1], 'Disconnected');
	assert.equal(byLabel['downlan (br-down)'][2], '0.00 KB/s');
	assert.equal(byLabel['downlan (br-down)'][4], '2.00 GB');
	assert.equal(byLabel['downlan (br-down)'][5], '512.00 MB');
	assert.equal(byLabel['downlan (br-down)'][6], '-');
	assert.equal(byLabel['lan2'][1], 'Disconnected');
	assert.equal(byLabel['lan2'][4], '300.00 MB');
	assert.equal(byLabel['wan/wan6 (eth4)'][4], `${(4 + n * 12 / 1024).toFixed(2)} GB`);
	assert.equal(byLabel['wan/wan6 (eth4)'][5], `${(512 + n * 3).toFixed(2)} MB`);
	assert(rateInMiB(byLabel['wan/wan6 (eth4)'][2]) > 3.7 && rateInMiB(byLabel['wan/wan6 (eth4)'][2]) < 4.3);
	assert(rateInMiB(byLabel['wan/wan6 (eth4)'][3]) > 0.8 && rateInMiB(byLabel['wan/wan6 (eth4)'][3]) < 1.2);
	assert(rateInMiB(byLabel['wan2/wan2v6 (eth5)'][2]) > 1.7 && rateInMiB(byLabel['wan2/wan2v6 (eth5)'][2]) < 2.3);
	assert(rateInMiB(byLabel['usb0'][2]) > 0.8 && rateInMiB(byLabel['usb0'][2]) < 1.2);
	assert(rateInMiB(byLabel['wgwan (wg0)'][2]) > 25);
	assert(rateInMiB(byLabel['modem (eth6)'][2]) > 15);
	assert(rateInMiB(byLabel['tun-raw'][2]) > 25);
	assert(rateInMiB(summary[2]) > 9.5 && rateInMiB(summary[2]) < 10.5);
	assert(rateInMiB(summary[3]) > 2.5 && rateInMiB(summary[3]) < 3.0);
	assert.equal(byLabel['usb0'][6], '-');
	assert.equal(rows.some(row => row[0] === 'pppoe-wan'), false);
	for (const ignored of [ 'lo', 'gre0', 'ifb0', 'mon.wlan0', 'sit0', 'wifi0' ])
		assert.equal(rows.some(row => row[0] === ignored), false);

	const cpuValue = tables.nth(0).locator('tbody tr').first().locator('td:last-child');
	await nextCPU('malformed');
	assert.equal((await cpuValue.innerText()).trim(), '-');
	await nextCPU('normal');
	assert.equal((await cpuValue.innerText()).trim(), '-');
	await nextCPU('normal');
	assert.equal((await cpuValue.innerText()).trim(), '20.00%');
	await nextCPU('reset');
	assert.equal((await cpuValue.innerText()).trim(), '-');
	await nextCPU('normal');
	assert.equal((await cpuValue.innerText()).trim(), '20.00%');

	const focusTarget = page.locator('a:visible').first();
	await focusTarget.focus();
	const focusHandle = await focusTarget.elementHandle();
	await page.evaluate(element => { window.__fixtureFocus = element; }, focusHandle);
	hotplug = true;
	await page.waitForTimeout(3500);
	await page.getByText('tun-hot', { exact: true }).waitFor();
	assert.equal(await page.evaluate(() => document.activeElement === window.__fixtureFocus), true);
	hotplug = false;
	await page.waitForTimeout(3500);
	assert.equal(await page.getByText('tun-hot', { exact: true }).count(), 0);
	assert.equal(await page.evaluate(() => document.activeElement === window.__fixtureFocus), true);
	resetLan1 = true;
	await page.waitForTimeout(3500);
	const resetRow = await tables.nth(1).locator('tbody tr').filter({ hasText: /^lan1/ }).evaluate(row =>
		Array.from(row.cells, cell => cell.textContent.trim()));
	assert.equal(resetRow[2], '0.00 KB/s');
	assert.equal(resetRow[3], '0.00 KB/s');
	assert.equal(results.consoleErrors.length, 0);
	assert.equal(results.pageErrors.length, 0);
	await screenshot(page, 'traffic-fixture');
	await page.unrouteAll({ behavior: 'wait' });
	await context.close();
}

async function sensorFixture(browser) {
	const fixture = {
		'coretemp-isa-0000': {
			'Package id 0': { temp1_input: 42.125, temp1_max: 80 },
			'Core 0': { temp2_input: 39 }
		},
		'nvme-pci-0100': { Composite: { temp1_input: 55.75 } }
	};
	const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	let sensorAttempts = 0;
	watch(page);
	if (process.env.MONITOR_DEBUG)
		page.on('request', request => {
			if (request.method() === 'POST')
				process.stdout.write(`fixture POST: ${new URL(request.url()).pathname}\n`);
		});

	await page.route('**/ubus/**', async route => {
		const batch = calls(route.request().postData());
		if (process.env.MONITOR_DEBUG)
			process.stdout.write(`fixture RPC: ${batch.map(call => `${call.params?.[1]}.${call.params?.[2]}`).join(', ')}\n`);
		const sensorCalls = batch.filter(call => call.params?.[1] === 'file' && call.params?.[2] === 'exec' &&
			call.params?.[3]?.command === '/usr/sbin/sensors' &&
			JSON.stringify(call.params?.[3]?.params) === JSON.stringify([ '-j', '-A' ]));
		const response = await route.fetch();
		let reply = await response.json();
		const replies = [].concat(reply);

		for (const call of sensorCalls) {
			const item = replies.find(candidate => candidate.id === call.id);
			if (item) {
				sensorAttempts++;
				item.result = sensorAttempts < 3
					? [ 0, { code: 1, stdout: '', stderr: 'temporary failure' } ]
					: [ 0, { code: 1, stdout: JSON.stringify(fixture), stderr: '' } ];
			}
		}

		if (sensorCalls.length)
			await route.fulfill({ response, body: JSON.stringify(Array.isArray(reply) ? replies : replies[0]) });
		else
			await route.fulfill({ response });
	});

	await login(page);
	await page.getByText('coretemp-isa-0000 / Package id 0', { exact: true }).waitFor();
	assert.equal(sensorAttempts, 3);
	assert.equal(await page.getByText('42.13 °C', { exact: true }).count(), 1);
	assert.equal(await page.getByText('39.00 °C', { exact: true }).count(), 1);
	assert.equal(await page.getByText('55.75 °C', { exact: true }).count(), 1);
	assert.equal(results.consoleErrors.length, 0);
	assert.equal(results.pageErrors.length, 0);
	await screenshot(page, 'sensor-fixture');
	await page.unrouteAll({ behavior: 'wait' });
	await context.close();
}

async function soak(browser) {
	const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage();
	const observed = watch(page);
	await login(page);
	await page.waitForTimeout(11000);

	const tables = page.locator('table');
	const summary = (await tables.nth(0).locator('tbody tr td:last-child').allTextContents()).map(value => value.trim());
	const rows = await tables.nth(1).locator('tbody tr').evaluateAll(items => items.map(row =>
		Array.from(row.cells, cell => cell.textContent.trim())));

	assert.match(summary[0], /^\d+(?:\.\d+)?%$/);
	assert.match(summary[1], /^\d+\.\d{2}%$/);
	assert.match(summary[2], /^\d+\.\d{2} (?:KB|MB|GB)\/s$/);
	assert.match(summary[3], /^\d+\.\d{2} (?:KB|MB|GB)\/s$/);
	assert(rows.length > 1);
	assert.equal(new Set(rows.map(row => row[0])).size, rows.length);
	assert(rows.some(row => row[0].includes('(br-lan)')));
	assert(rows.some(row => row[0].includes('(eth4)') && /(?:^|\/)wan(?:\/| )/.test(row[0])));
	for (const row of rows) {
		assert.match(row[2], /^(?:\d+\.\d{2} (?:KB|MB|GB)\/s|-)$/);
		assert.match(row[3], /^(?:\d+\.\d{2} (?:KB|MB|GB)\/s|-)$/);
		assert.match(row[4], /^(?:\d+\.\d{2} (?:KB|MB|GB|TB)|-)$/);
		assert.match(row[5], /^(?:\d+\.\d{2} (?:KB|MB|GB|TB)|-)$/);
	}
	assert.equal(await tables.nth(0).locator('tbody tr').count(), 4);
	assert.equal(observed.sensorRequests.length, 1);
	await page.waitForTimeout(500);
	assert.equal(observed.sensorReplies.length, 1);
	assert.equal(observed.sensorReplies[0]?.result?.[0], 0);
	assert.deepEqual(JSON.parse(observed.sensorReplies[0].result[1].stdout), {});

	const denied = await page.evaluate(async () => {
		const response = await fetch('/ubus', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1, method: 'call',
				params: [ L.env.sessionid, 'file', 'exec', { command: '/bin/echo', params: [ 'denied' ] } ]
			})
		});
		return response.json();
	});
	assert.notEqual(denied.result?.[0], 0);
	assert.equal(results.pageErrors.length, 0);
	results.consoleErrors.length = 0;
	results.pageErrors.length = 0;

	const focusTarget = page.locator('a:visible').first();
	await focusTarget.focus();
	const focusHandle = await focusTarget.elementHandle();
	await page.evaluate(element => { window.__monitorFocus = element; }, focusHandle);
	const domBefore = await page.locator('*').count();
	await page.waitForTimeout(11000);
	assert.equal(await page.evaluate(() => document.activeElement === window.__monitorFocus), true);
	assert.equal(await page.locator('*').count(), domBefore);

	const cdp = await context.newCDPSession(page);
	await cdp.send('HeapProfiler.collectGarbage');
	const heapBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize;
	const deadline = Date.now() + soakMinutes * 60000;
	let maxDom = domBefore;

	while (Date.now() < deadline) {
		await page.waitForTimeout(Math.min(60000, deadline - Date.now()));
		maxDom = Math.max(maxDom, await page.locator('*').count());
		process.stdout.write(`soak ${Math.min(soakMinutes, (soakMinutes * 60000 - deadline + Date.now()) / 60000).toFixed(1)}/${soakMinutes} min\n`);
	}

	await cdp.send('HeapProfiler.collectGarbage');
	const heapAfter = (await cdp.send('Runtime.getHeapUsage')).usedSize;
	const intervals = observed.polls.slice(1).map((time, index) => time - observed.polls[index]);
	const steadyIntervals = intervals.filter(interval => interval >= 2000);
	const intervalAverage = steadyIntervals.reduce((sum, value) => sum + value, 0) / steadyIntervals.length;

	assert(steadyIntervals.length >= Math.max(2, Math.floor(soakMinutes * 18)));
	assert(steadyIntervals.every(interval => interval >= 2500 && interval <= 4500));
	assert(intervalAverage >= 2900 && intervalAverage <= 3100);
	assert.equal(maxDom, domBefore);
	assert.equal(await page.locator('*').count(), domBefore);
	assert(heapAfter - heapBefore <= 1024 ** 2);
	assert.equal(results.consoleErrors.length, 0);
	assert.equal(results.pageErrors.length, 0);

	Object.assign(results, {
		domBefore,
		domAfter: await page.locator('*').count(),
		maxDom,
		heapBefore,
		heapAfter,
		heapDelta: heapAfter - heapBefore,
		pollCount: observed.polls.length,
		pollIntervalMin: Math.min(...steadyIntervals),
		pollIntervalMax: Math.max(...steadyIntervals),
		pollIntervalAverage: intervalAverage,
		focusPreserved: true,
		sensorRequests: observed.sensorRequests.length
	});
	await screenshot(page, 'english-desktop');
	await context.close();
}

(async () => {
	const browser = await chromium.launch({
		executablePath: chromePath,
		headless: true,
		args: [ '--ignore-certificate-errors' ]
	});

	try {
		await trafficFixture(browser);
		await sensorFixture(browser);
		await smoke(browser, 'en-US', { width: 390, height: 844 }, 'Router Monitor',
			[ 'Interface Name', 'Status', 'RX', 'TX', 'Total RX', 'Total TX', 'Connected Since' ],
			'english-mobile');
		await smoke(browser, 'zh-CN', { width: 1440, height: 1000 }, '监视器',
			[ '线路名称', '状态', '接收 (RX)', '发送 (TX)', '累计接收', '累计发送', '连接时间' ],
			'chinese-desktop');
		await smoke(browser, 'zh-CN', { width: 390, height: 844 }, '监视器',
			[ '线路名称', '状态', '接收 (RX)', '发送 (TX)', '累计接收', '累计发送', '连接时间' ],
			'chinese-mobile');
		await soak(browser);
	}
	finally {
		await browser.close();
		fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2));
	}

	process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
})().catch(error => {
	process.stderr.write(`${error.stack}\n`);
	process.exitCode = 1;
});
