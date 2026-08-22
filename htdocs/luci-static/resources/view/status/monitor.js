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
		rx: elapsed > 0 && current.rx >= previous.rx ? (current.rx - previous.rx) / elapsed : 0,
		tx: elapsed > 0 && current.tx >= previous.tx ? (current.tx - previous.tx) / elapsed : 0,
		sample: { key: key, rx: current.rx, tx: current.tx, time: now }
	};
}

function counters(devices, name) {
	var stats = devices[name] && devices[name].stats;

	if (!stats)
		return null;

	return {
		rx: Math.max(Number(stats.rx_bytes) || 0, 0),
		tx: Math.max(Number(stats.tx_bytes) || 0, 0)
	};
}

function configuredInterfaces(interfaces) {
	return interfaces.filter(function(info) {
		return info && typeof(info.interface) == 'string' &&
			info.interface != 'loopback' && info.dynamic !== true;
	});
}

function defaultRouteDevices(interfaces) {
	var devices = {};

	interfaces.forEach(function(info) {
		if (!info || info.up !== true || typeof(info.l3_device) != 'string')
			return;

		if ((Array.isArray(info.route) ? info.route : []).some(function(route) {
			return route && Number(route.mask) == 0 &&
				(route.target == '0.0.0.0' || route.target == '::');
		}))
			devices[info.l3_device] = true;
	});

	return Object.keys(devices).sort();
}

function parseSensors(result) {
	var data;

	if (!result || typeof(result.stdout) != 'string')
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
		return Promise.all([ uci.load('system'), loadSnapshot(true) ]);
	},

	buildInterfaceRows: function(interfaces) {
		this.interfaceRows = {};

		dom.content(this.interfaceBody, interfaces.map(L.bind(function(info) {
			var nodes = {}, name = info.interface;
			this.interfaceRows[name] = nodes;

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'data-title': _('Interface Name', 'luci-app-monitor') }, name),
				valueCell(nodes, 'status', _('Status', 'luci-app-monitor')),
				valueCell(nodes, 'download', _('Download', 'luci-app-monitor')),
				valueCell(nodes, 'upload', _('Upload', 'luci-app-monitor')),
				valueCell(nodes, 'totalDownload', _('Total Download', 'luci-app-monitor')),
				valueCell(nodes, 'totalUpload', _('Total Upload', 'luci-app-monitor')),
				valueCell(nodes, 'connected', _('Connected Since', 'luci-app-monitor'))
			]);
		}, this)));
	},

	updateSensors: function(result, initial) {
		var sensors = parseSensors(result);

		if (sensors == null) {
			if (initial)
				this.pollSensors = false;
			return;
		}

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

	update: function(snapshot, initial) {
		var system = snapshot[0],
		    allInterfaces = Array.isArray(snapshot[1]) ? snapshot[1] : [],
		    devices = snapshot[2] || {},
		    cpu = snapshot[3] || {},
		    interfaces = configuredInterfaces(allInterfaces),
		    now = Date.now(),
		    interfaceKey = JSON.stringify(interfaces.map(function(info) { return info.interface; }));

		this.metricNodes.cpu.data = typeof(cpu.cpuusage) == 'string' ? cpu.cpuusage : '-';

		var memory = system.memory || {};
		this.metricNodes.memory.data = Number(memory.total) > 0
			? '%.2f%%'.format((Number(memory.total) - Number(memory.free || 0)) * 100 / Number(memory.total))
			: '-';

		if (interfaceKey != this.interfaceKey) {
			this.interfaceKey = interfaceKey;
			this.buildInterfaceRows(interfaces);
		}

		var nextSamples = {};
		interfaces.forEach(L.bind(function(info) {
			var nodes = this.interfaceRows[info.interface],
			    current = info.up === true && typeof(info.l3_device) == 'string'
					? counters(devices, info.l3_device) : null,
			    status = info.up === true ? _('Connected', 'luci-app-monitor') :
					(info.pending === true ? _('Pending', 'luci-app-monitor') :
						_('Disconnected', 'luci-app-monitor'));

			nodes.status.data = status;

			if (!current) {
				nodes.download.data = formatBytes(0, true);
				nodes.upload.data = formatBytes(0, true);
				nodes.totalDownload.data = '-';
				nodes.totalUpload.data = '-';
				nodes.connected.data = '-';
				return;
			}

			var lineRates = rates(this.lineSamples[info.interface], current, info.l3_device, now);
			nextSamples[info.interface] = lineRates.sample;
			nodes.download.data = formatBytes(lineRates.rx, true);
			nodes.upload.data = formatBytes(lineRates.tx, true);
			nodes.totalDownload.data = formatBytes(current.rx, false);
			nodes.totalUpload.data = formatBytes(current.tx, false);
			nodes.connected.data = formatStartTime(this.dateFormatter, system.localtime, info.uptime);
		}, this));
		this.lineSamples = nextSamples;

		var defaultDevices = defaultRouteDevices(allInterfaces).filter(function(name) {
			return counters(devices, name) != null;
		}), total = { rx: 0, tx: 0 };
		defaultDevices.forEach(function(name) {
			var current = counters(devices, name);
			if (current) {
				total.rx += current.rx;
				total.tx += current.tx;
			}
		});

		var totalRates = rates(this.totalSample, total, JSON.stringify(defaultDevices), now);
		this.totalSample = totalRates.sample;
		this.metricNodes.download.data = formatBytes(totalRates.rx, true);
		this.metricNodes.upload.data = formatBytes(totalRates.tx, true);

		if (initial || this.pollSensors)
			this.updateSensors(snapshot[4], initial);
	},

	render: function(data) {
		this.metricNodes = {};
		this.interfaceRows = {};
		this.sensorNodes = {};
		this.lineSamples = {};
		this.totalSample = null;
		this.pollSensors = true;
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

		this.update(data[1], true);
		poll.add(L.bind(function() {
			return loadSnapshot(this.pollSensors).then(L.bind(function(snapshot) {
				this.update(snapshot, false);
			}, this));
		}, this), 5);

		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
