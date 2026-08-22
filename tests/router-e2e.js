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

async function smoke(browser, locale, viewport, expectedTitle, name) {
	const context = await browser.newContext({ locale, viewport });
	const page = await context.newPage();
	watch(page);
	await login(page);
	await page.waitForTimeout(6000);
	assert.equal((await page.locator('h2').innerText()).trim(), expectedTitle);
	assert.equal(await page.locator('table').nth(1).locator('tbody tr').count(), 2);
	assert.deepEqual(await page.locator('table').nth(1).locator('tbody tr td:first-child').allTextContents(),
		[ 'lan (br-lan)', 'wan (eth4)' ]);
	assert.equal(await page.locator('table').nth(1).locator('tbody tr td[data-title]').count(), 14);
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
		{ interface: 'modem', up: true, dynamic: false, uptime: 800, device: 'eth4', l3_device: 'eth4', route: [] },
		{ interface: 'wan6', up: false, pending: true, dynamic: false, device: 'eth4' },
		{ interface: 'lan', up: true, dynamic: false, uptime: 1000, device: 'br-lan', l3_device: 'br-lan', route: [] },
		{ interface: 'wan', up: true, dynamic: false, uptime: 900, device: 'eth4', l3_device: 'pppoe-wan', route: [
			{ target: '0.0.0.0', mask: 0 }
		] },
		{ interface: 'wan_6', up: true, dynamic: true, uptime: 880, device: 'pppoe-wan', l3_device: 'pppoe-wan',
			data: { zone: 'wan' }, route: [ { target: '::', mask: 0 } ] },
		{ interface: 'vpn', up: true, dynamic: true, uptime: 700, device: 'tailscale0', l3_device: 'tailscale0',
			data: { zone: 'vpn' }, route: [ { target: '0.0.0.0', mask: 0 } ] }
	];
	const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	let sample = -1;

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

			if (object === 'network.interface' && method === 'dump') {
				item.result = [ 0, { interface: interfaces } ];
				changed = true;
			}
			else if (object === 'luci-rpc' && method === 'getNetworkDevices') {
				item.result = [ 0, {
					'br-lan': { stats: { rx_bytes: 256 * MiB + n * 5 * MiB, tx_bytes: 8 * GiB + n * 20 * MiB } },
					'eth4': { stats: { rx_bytes: 4 * GiB + n * 10 * MiB, tx_bytes: 512 * MiB + n * 2.5 * MiB } },
					'pppoe-wan': { stats: { rx_bytes: 64 * GiB + n * 100 * MiB, tx_bytes: 32 * GiB + n * 50 * MiB } },
					'tailscale0': { stats: { rx_bytes: 128 * GiB + n * GiB, tx_bytes: 128 * GiB + n * GiB } }
				} ];
				changed = true;
			}
			else if (object === 'system' && method === 'info') {
				item.result = [ 0, { localtime: 1787429279 + n * 5, memory: { total: 1024, free: 256 } } ];
				changed = true;
			}
			else if (object === 'luci' && method === 'getCPUUsage') {
				item.result = [ 0, { cpuusage: '12%' } ];
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
	await page.waitForTimeout(6200);
	const tables = page.locator('table');
	const summary = (await tables.nth(0).locator('tbody tr td:last-child').allTextContents()).map(value => value.trim());
	const rows = await tables.nth(1).locator('tbody tr').evaluateAll(items => items.map(row =>
		Array.from(row.cells, cell => cell.textContent.trim())));
	const n = sample;

	assert.deepEqual(rows.map(row => row[0]), [ 'lan (br-lan)', 'wan (eth4)' ]);
	assert.deepEqual(rows.map(row => row[1]), [ 'Connected', 'Connected' ]);
	assert.equal(rows[0][4], `${(8 + n * 20 / 1024).toFixed(2)} GB`);
	assert.equal(rows[0][5], `${(256 + n * 5).toFixed(2)} MB`);
	assert.equal(rows[1][4], `${(4 + n * 10 / 1024).toFixed(2)} GB`);
	assert.equal(rows[1][5], `${(512 + n * 2.5).toFixed(2)} MB`);
	assert(rateInMiB(rows[0][2]) > 3.2 && rateInMiB(rows[0][2]) < 4.8);
	assert(rateInMiB(rows[0][3]) > 0.8 && rateInMiB(rows[0][3]) < 1.2);
	assert(rateInMiB(rows[1][2]) > 1.6 && rateInMiB(rows[1][2]) < 2.4);
	assert(rateInMiB(rows[1][3]) > 0.4 && rateInMiB(rows[1][3]) < 0.6);
	assert.equal(summary[2], rows[1][2]);
	assert.equal(summary[3], rows[1][3]);
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
	assert.deepEqual(rows.map(row => row[0]), [ 'lan (br-lan)', 'wan (eth4)' ]);
	for (const row of rows) {
		assert.match(row[2], /^\d+\.\d{2} (?:KB|MB|GB)\/s$/);
		assert.match(row[3], /^\d+\.\d{2} (?:KB|MB|GB)\/s$/);
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
	const steadyIntervals = intervals.filter(interval => interval >= 3000);

	assert(steadyIntervals.length >= Math.max(2, Math.floor(soakMinutes * 10)));
	assert(steadyIntervals.every(interval => interval >= 4000 && interval <= 6500));
	assert.equal(maxDom, domBefore);
	assert.equal(await page.locator('*').count(), domBefore);
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
		pollIntervalAverage: steadyIntervals.reduce((sum, value) => sum + value, 0) / steadyIntervals.length,
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
		await smoke(browser, 'en-US', { width: 390, height: 844 }, 'Router Monitor', 'english-mobile');
		await smoke(browser, 'zh-CN', { width: 1440, height: 1000 }, '监视器', 'chinese-desktop');
		await smoke(browser, 'zh-CN', { width: 390, height: 844 }, '监视器', 'chinese-mobile');
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
