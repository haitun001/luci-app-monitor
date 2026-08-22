'use strict';
'require view';
'require dom';
'require fs';
'require poll';
'require rpc';
'require uci';

var callSystemInfo = rpc.declare({
	object: 'system',
	method: 'info'
});

var callInterfaceDump = rpc.declare({
	object: 'network.interface',
	method: 'dump',
	expect: { interface: [] }
});

var callNetworkDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getNetworkDevices',
	expect: { '': {} }
});

var callCPUUsage = rpc.declare({
	object: 'luci',
	method: 'getCPUUsage'
});

function loadSnapshot(withSensors) {
	return Promise.all([
		L.resolveDefault(callSystemInfo(), {}),
		L.resolveDefault(callInterfaceDump(), []),
		L.resolveDefault(callNetworkDevices(), {}),
		L.resolveDefault(callCPUUsage(), {}),
		withSensors ? L.resolveDefault(fs.exec('/usr/sbin/sensors', [ '-j', '-A' ]), null) : null
	]);
}

function formatBytes(bytes, rate) {
	var units = rate ? [ 'KB/s', 'MB/s', 'GB/s' ] : [ 'KB', 'MB', 'GB', 'TB' ],
	    value = Math.max(Number(bytes) || 0, 0) / 1024,
	    unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}

	return '%.2f %s'.format(value, units[unit]);
}

function rates(previous, current, key, now) {
	var elapsed = previous && previous.key == key ? (now - previous.time) / 1000 : 0;

	return {
		download: elapsed > 0 && current.download >= previous.download
			? (current.download - previous.download) / elapsed : 0,
		upload: elapsed > 0 && current.upload >= previous.upload
			? (current.upload - previous.upload) / elapsed : 0,
		sample: {
			key: key,
			download: current.download,
			upload: current.upload,
			time: now
		}
	};
}

function counters(devices, name, reverse) {
	var stats = devices[name] && devices[name].stats;

	if (!stats)
		return null;

	var rx = Math.max(Number(stats.rx_bytes) || 0, 0),
	    tx = Math.max(Number(stats.tx_bytes) || 0, 0);

	return reverse
		? { download: tx, upload: rx }
		: { download: rx, upload: tx };
}

function hasDefaultRoute(info) {
	return info && info.up === true &&
		(Array.isArray(info.route) ? info.route : []).some(function(route) {
			return route && Number(route.mask) == 0 &&
				(route.target == '0.0.0.0' || route.target == '::');
		});
}

function wanNetworkNames() {
	var zones = uci.sections('firewall', 'zone');

	for (var i = 0; i < zones.length; i++)
		if (zones[i].name == 'wan')
			return L.toArray(zones[i].network);

	return [];
}

function relatedInterface(group, info) {
	var names = [ info.device, info.l3_device ].filter(function(name) {
		return typeof(name) == 'string';
	});

	return group.members.some(function(member) {
		return names.indexOf(member.device) != -1 ||
			names.indexOf(member.l3_device) != -1;
	});
}

function lineDefinitions(interfaces) {
	var byName = {}, groups = {}, groupOrder = [], lines = [];

	interfaces.forEach(function(info) {
		if (info && typeof(info.interface) == 'string')
			byName[info.interface] = info;
	});

	var lan = byName.lan;
	if (lan) {
		lines.push({
			key: 'lan',
			kind: 'lan',
			name: 'lan',
			device: typeof(lan.l3_device) == 'string' ? lan.l3_device : lan.device,
			connected: lan.up === true,
			pending: lan.pending === true,
			uptime: lan.uptime
		});
	}

	wanNetworkNames().forEach(function(name) {
		var info = byName[name];

		if (!info || (uci.get('network', name, 'defaultroute') == '0' && !hasDefaultRoute(info)))
			return;

		var device = typeof(info.device) == 'string' ? info.device : null,
		    key = device || '?' + name,
		    group = groups[key];

		if (!group) {
			group = groups[key] = { key: key, device: device, members: [], dynamic: [] };
			groupOrder.push(group);
		}

		group.members.push(info);
	});

	interfaces.forEach(function(info) {
		if (!info || info.dynamic !== true || !hasDefaultRoute(info))
			return;

		for (var i = 0; i < groupOrder.length; i++) {
			if (relatedInterface(groupOrder[i], info)) {
				groupOrder[i].dynamic.push(info);
				break;
			}
		}
	});

	groupOrder.forEach(function(group) {
		var active = group.members.filter(hasDefaultRoute)[0] || group.dynamic[0] || null,
		    display = group.members.filter(hasDefaultRoute)[0];

		if (!display && active)
			display = group.members.filter(function(info) {
				return relatedInterface({ members: [ info ] }, active);
			})[0];

		display = display || group.members[0] || active;
		lines.push({
			key: 'wan\u0000' + group.key,
			kind: 'wan',
			name: display.interface,
			device: group.device,
			connected: active != null,
			pending: active == null && group.members.some(function(info) {
				return info.pending === true;
			}),
			uptime: active && active.uptime
		});
	});

	return lines;
}

function parseSensors(result) {
	var data;

	if (!result || Number(result.code) != 0 || typeof(result.stdout) != 'string')
		return null;

	try {
		data = JSON.parse(result.stdout);
	}
	catch (e) {
		return null;
	}

	if (!data || typeof(data) != 'object' || Array.isArray(data))
		return null;

	var values = [];

	Object.keys(data).sort().forEach(function(chip) {
		if (!data[chip] || typeof(data[chip]) != 'object')
			return;

		Object.keys(data[chip]).sort().forEach(function(label) {
			var feature = data[chip][label];

			if (!feature || typeof(feature) != 'object')
				return;

			Object.keys(feature).sort().forEach(function(input) {
				if (/^temp\d+_input$/.test(input) &&
					typeof(feature[input]) == 'number' && isFinite(feature[input])) {
					values.push({
						key: [ chip, label, input ].join('\u0000'),
						name: '%s / %s'.format(chip, label),
						value: feature[input]
					});
				}
			});
		});
	});

	return values;
}

function valueCell(nodes, key, title) {
	var value = document.createTextNode('-'),
	    attributes = { 'class': 'td left' };

	nodes[key] = value;
	if (title != null)
		attributes['data-title'] = title;

	return E('td', attributes, value);
}

function valueRow(label, nodes, key) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, label),
		valueCell(nodes, key)
	]);
}

function formatStartTime(formatter, localtime, uptime) {
	if (!formatter || !(Number(localtime) > 0) || !(Number(uptime) >= 0))
		return '-';

	var parts = {}, date = new Date((Number(localtime) - Number(uptime)) * 1000);

	formatter.formatToParts(date).forEach(function(part) {
		parts[part.type] = part.value;
	});

	return '%s-%s-%s %s:%s:%s'.format(
		parts.year, parts.month, parts.day,
		parts.hour, parts.minute, parts.second);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('system'),
			uci.load('network'),
			uci.load('firewall'),
			loadSnapshot(true)
		]);
	},

	buildInterfaceRows: function(lines) {
		this.interfaceRows = {};

		dom.content(this.interfaceBody, lines.map(L.bind(function(line) {
			var nodes = {};
			this.interfaceRows[line.key] = nodes;

			return E('tr', { 'class': 'tr' }, [
				valueCell(nodes, 'name', _('Interface Name', 'luci-app-monitor')),
				valueCell(nodes, 'status', _('Status', 'luci-app-monitor')),
				valueCell(nodes, 'download', _('Download', 'luci-app-monitor')),
				valueCell(nodes, 'upload', _('Upload', 'luci-app-monitor')),
				valueCell(nodes, 'totalDownload', _('Total Download', 'luci-app-monitor')),
				valueCell(nodes, 'totalUpload', _('Total Upload', 'luci-app-monitor')),
				valueCell(nodes, 'connected', _('Connected Since', 'luci-app-monitor'))
			]);
		}, this)));
	},

	updateSensors: function(result) {
		var sensors = parseSensors(result);

		if (sensors == null) {
			this.sensorFailures++;
			if (this.sensorFailures >= 3)
				this.pollSensors = false;

			Object.keys(this.sensorNodes).forEach(L.bind(function(key) {
				this.sensorNodes[key].data = '-';
			}, this));
			return;
		}

		this.sensorFailures = 0;
		if (!sensors.length)
			this.pollSensors = false;

		var key = JSON.stringify(sensors.map(function(sensor) { return sensor.key; }));

		if (key != this.sensorKey) {
			this.sensorKey = key;
			this.sensorNodes = {};
			dom.content(this.sensorBody, sensors.map(L.bind(function(sensor) {
				return valueRow(sensor.name, this.sensorNodes, sensor.key);
			}, this)));
		}

		sensors.forEach(L.bind(function(sensor) {
			this.sensorNodes[sensor.key].data = '%.2f \u00b0C'.format(sensor.value);
		}, this));
	},

	update: function(snapshot) {
		var system = snapshot[0],
		    allInterfaces = Array.isArray(snapshot[1]) ? snapshot[1] : [],
		    devices = snapshot[2] || {},
		    cpu = snapshot[3] || {},
		    lines = lineDefinitions(allInterfaces),
		    now = Date.now(),
		    interfaceKey = JSON.stringify(lines.map(function(line) { return line.key; }));

		this.metricNodes.cpu.data = typeof(cpu.cpuusage) == 'string' ? cpu.cpuusage : '-';

		var memory = system.memory || {};
		this.metricNodes.memory.data = Number(memory.total) > 0
			? '%.2f%%'.format((Number(memory.total) - Number(memory.free || 0)) * 100 / Number(memory.total))
			: '-';

		if (interfaceKey != this.interfaceKey) {
			this.interfaceKey = interfaceKey;
			this.buildInterfaceRows(lines);
		}

		var nextSamples = {}, total = { download: 0, upload: 0 },
		    totalDevices = [], totalAvailable = true;
		lines.forEach(L.bind(function(line) {
			var nodes = this.interfaceRows[line.key],
			    current = line.connected && line.device
					? counters(devices, line.device, line.kind == 'lan') : null,
			    status = line.connected ? _('Connected', 'luci-app-monitor') :
					(line.pending ? _('Pending', 'luci-app-monitor') :
						_('Disconnected', 'luci-app-monitor'));

			nodes.name.data = '%s (%s)'.format(line.name, line.device || '-');
			nodes.status.data = status;

			if (!current) {
				nodes.download.data = line.connected ? '-' : formatBytes(0, true);
				nodes.upload.data = line.connected ? '-' : formatBytes(0, true);
				nodes.totalDownload.data = '-';
				nodes.totalUpload.data = '-';
				nodes.connected.data = line.connected
					? formatStartTime(this.dateFormatter, system.localtime, line.uptime) : '-';

				if (line.kind == 'wan' && line.connected)
					totalAvailable = false;
				return;
			}

			var lineRates = rates(this.lineSamples[line.key], current, line.device, now);
			nextSamples[line.key] = lineRates.sample;
			nodes.download.data = formatBytes(lineRates.download, true);
			nodes.upload.data = formatBytes(lineRates.upload, true);
			nodes.totalDownload.data = formatBytes(current.download, false);
			nodes.totalUpload.data = formatBytes(current.upload, false);
			nodes.connected.data = formatStartTime(this.dateFormatter, system.localtime, line.uptime);

			if (line.kind == 'wan') {
				total.download += current.download;
				total.upload += current.upload;
				totalDevices.push(line.device);
			}
		}, this));
		this.lineSamples = nextSamples;

		if (totalAvailable) {
			var totalRates = rates(this.totalSample, total, JSON.stringify(totalDevices), now);
			this.totalSample = totalRates.sample;
			this.metricNodes.download.data = formatBytes(totalRates.download, true);
			this.metricNodes.upload.data = formatBytes(totalRates.upload, true);
		}
		else {
			this.totalSample = null;
			this.metricNodes.download.data = '-';
			this.metricNodes.upload.data = '-';
		}

		if (this.pollSensors)
			this.updateSensors(snapshot[4]);
	},

	render: function(data) {
		this.metricNodes = {};
		this.interfaceRows = {};
		this.sensorNodes = {};
		this.lineSamples = {};
		this.totalSample = null;
		this.pollSensors = true;
		this.sensorFailures = 0;
		this.interfaceKey = null;
		this.sensorKey = null;

		var zone = uci.get('system', '@system[0]', 'zonename');
		zone = typeof(zone) == 'string' ? zone.replaceAll(' ', '_') : 'UTC';

		try {
			this.dateFormatter = new Intl.DateTimeFormat('en-CA', {
				timeZone: zone,
				year: 'numeric', month: '2-digit', day: '2-digit',
				hour: '2-digit', minute: '2-digit', second: '2-digit',
				hourCycle: 'h23'
			});
		}
		catch (e) {
			this.dateFormatter = null;
		}

		var summaryBody = E('tbody', [
			valueRow(_('CPU Usage', 'luci-app-monitor'), this.metricNodes, 'cpu'),
			valueRow(_('Memory Usage', 'luci-app-monitor'), this.metricNodes, 'memory'),
			valueRow(_('Download', 'luci-app-monitor'), this.metricNodes, 'download'),
			valueRow(_('Upload', 'luci-app-monitor'), this.metricNodes, 'upload')
		]);
		this.sensorBody = E('tbody');
		this.interfaceBody = E('tbody');

		var page = E([], [
			E('h2', _('Router Monitor')),
			E('table', { 'class': 'table' }, [ summaryBody, this.sensorBody ]),
			E('h3', _('Interfaces', 'luci-app-monitor')),
			E('table', { 'class': 'table' }, [
				E('thead', {}, E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th left' }, _('Interface Name', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Status', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Download', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Upload', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Total Download', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Total Upload', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Connected Since', 'luci-app-monitor'))
				])),
				this.interfaceBody
			])
		]);

		this.update(data[3]);
		poll.add(L.bind(function() {
			return loadSnapshot(this.pollSensors).then(L.bind(function(snapshot) {
				this.update(snapshot);
			}, this));
		}, this), 5);

		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
