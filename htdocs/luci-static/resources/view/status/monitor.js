'use strict';
'require view';
'require dom';
'require fs';
'require poll';
'require rpc';
'require uci';
'require validation';

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

function loadSnapshot(withSensors) {
	return Promise.all([
		L.resolveDefault(callSystemInfo(), {}),
		L.resolveDefault(callInterfaceDump(), []),
		L.resolveDefault(callNetworkDevices(), {}),
		L.resolveDefault(fs.read('/proc/stat'), null),
		withSensors ? L.resolveDefault(fs.exec('/usr/sbin/sensors', [ '-j', '-A' ]), null) : null,
		L.resolveDefault(fs.read_direct('/proc/net/nf_conntrack'), null)
	]);
}

function cpuUsage(previous, data) {
	var match = typeof(data) == 'string' &&
		data.match(/^cpu[\t ]+(\d+(?:[\t ]+\d+){3,})[\t ]*$/m);

	if (!match)
		return { value: '-', sample: null };

	var values = match[1].trim().split(/[\t ]+/).slice(0, 8).map(Number),
	    sample = {
		    total: values.reduce(function(sum, value) { return sum + value; }, 0),
		    idle: values[3] + (values[4] || 0)
	    },
	    total = previous ? sample.total - previous.total : 0,
	    idle = previous ? sample.idle - previous.idle : 0;

	return {
		value: previous && total > 0 && idle >= 0 && idle <= total
			? '%.2f%%'.format((total - idle) * 100 / total) : '-',
		sample: sample.total > 0 && sample.idle <= sample.total ? sample : null
	};
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
		rx: elapsed > 0 && current.rx >= previous.rx
			? (current.rx - previous.rx) / elapsed : 0,
		tx: elapsed > 0 && current.tx >= previous.tx
			? (current.tx - previous.tx) / elapsed : 0,
		sample: {
			key: key,
			rx: current.rx,
			tx: current.tx,
			time: now
		}
	};
}

function counters(devices, name) {
	var stats = devices[name] && devices[name].stats;

	if (!stats || stats.rx_bytes == null || stats.tx_bytes == null ||
		!isFinite(Number(stats.rx_bytes)) || !isFinite(Number(stats.tx_bytes)))
		return null;

	return {
		rx: Math.max(Number(stats.rx_bytes), 0),
		tx: Math.max(Number(stats.tx_bytes), 0)
	};
}

function hasDefaultRoute(info) {
	return info && info.up === true &&
		(Array.isArray(info.route) ? info.route : []).some(function(route) {
			return route && Number(route.mask) == 0 &&
				(route.target == '0.0.0.0' || route.target == '::');
		});
}

function wanZone() {
	var zones = uci.sections('firewall', 'zone');

	for (var i = 0; i < zones.length; i++)
		if (zones[i].name == 'wan')
			return zones[i];

	return null;
}

function interfaceDevices(info) {
	var names = [];

	[ info && info.device, info && info.l3_device ].forEach(function(name) {
		if (typeof(name) == 'string' && names.indexOf(name) == -1)
			names.push(name);
	});

	return names;
}

function accountingDevice(info, devices) {
	if (typeof(info.device) == 'string' && counters(devices, info.device))
		return { name: info.device, lower: true };

	if (typeof(info.l3_device) == 'string' && counters(devices, info.l3_device))
		return { name: info.l3_device, lower: false };

	if (typeof(info.device) == 'string')
		return { name: info.device, lower: true };

	if (typeof(info.l3_device) == 'string')
		return { name: info.l3_device, lower: false };

	return null;
}

function ignoredRawDevice(name) {
	return name == 'lo' || /^(?:wmaster|wifi|hwsim|imq|ifb)\d+$/.test(name) ||
		/^mon\.wlan\d+$/.test(name) ||
		/^(?:sit|gre|gretap|ip6gre|ip6tnl|tunl)0$/.test(name);
}

function addInterface(group, info) {
	group.members.push(info);
	interfaceDevices(info).forEach(function(name) {
		group.aliases[name] = true;
	});
}

function lineDefinitions(interfaces, devices) {
	var groups = {}, groupOrder = [], byInterface = {};

	function groupFor(choice) {
		var group = groups[choice.name];

		if (!group) {
			group = groups[choice.name] = {
				device: choice.name,
				lower: choice.lower,
				members: [],
				aliases: {}
			};
			groupOrder.push(group);
		}
		else if (choice.lower) {
			group.lower = true;
		}

		return group;
	}

	interfaces.forEach(function(info) {
		if (!info || info.dynamic === true || typeof(info.interface) != 'string')
			return;

		var choice = accountingDevice(info, devices);

		if (!choice || choice.name == 'lo')
			return;

		var group = groupFor(choice);
		addInterface(group, info);
		byInterface[info.interface] = group;
	});

	interfaces.forEach(function(info) {
		if (!info || info.dynamic !== true || typeof(info.interface) != 'string')
			return;

		var names = interfaceDevices(info), group = null;

		for (var i = 0; i < groupOrder.length && !group; i++)
			if (names.some(function(name) { return groupOrder[i].aliases[name]; }))
				group = groupOrder[i];

		if (!group) {
			var choice = accountingDevice(info, devices);

			if (!choice || choice.name == 'lo')
				return;

			group = groupFor(choice);
		}

		addInterface(group, info);
		byInterface[info.interface] = group;
	});

	var used = {}, lines = groupOrder.map(function(group) {
		Object.keys(group.aliases).forEach(function(name) { used[name] = true; });

		var configured = group.members.filter(function(info) { return info.dynamic !== true; }),
		    names = (configured.length ? configured : group.members).map(function(info) {
			    return info.interface;
		    }).filter(function(name, index, all) {
			    return all.indexOf(name) == index;
		    }).sort(L.naturalCompare),
		    active = group.members.filter(hasDefaultRoute)[0] ||
			    group.members.filter(function(info) { return info.up === true; })[0] || null;

		return {
			key: 'line\u0000' + group.device,
			name: names.join('/'),
			device: group.device,
			aliases: Object.keys(group.aliases),
			members: group.members,
			connected: active != null,
			pending: active == null && group.members.some(function(info) {
				return info.pending === true;
			}),
			uptime: active && active.uptime
		};
	}).sort(function(a, b) {
		return L.naturalCompare(a.name, b.name) || L.naturalCompare(a.device, b.device);
	});

	Object.keys(devices).sort(L.naturalCompare).forEach(function(name) {
		if (used[name] || ignoredRawDevice(name) || !counters(devices, name))
			return;

		lines.push({
			key: 'line\u0000' + name,
			name: name,
			device: name,
			aliases: [ name ],
			members: [],
			connected: devices[name].up === true,
			pending: false,
			uptime: null
		});
	});

	return { lines: lines, groups: byInterface };
}

function matchesDevice(pattern, name) {
	if (pattern == '+')
		return true;

	return pattern.slice(-1) == '+'
		? name.indexOf(pattern.slice(0, -1)) == 0
		: name == pattern;
}

function wanDevices(interfaces, devices, groups) {
	var zone = wanZone(), lower = {}, fallback = {}, zoneNetworks = {}, excludedNetworks = {};

	if (!zone)
		return { names: [], available: true };

	L.toArray(zone.network).forEach(function(name) {
		if (typeof(name) != 'string')
			return;

		(name.charAt(0) == '!' ? excludedNetworks : zoneNetworks)[
			name.charAt(0) == '!' ? name.slice(1) : name
		] = true;
	});

	function addCandidate(group, name) {
		var target = group ? group.device : name,
		    pointToPoint = devices[name] && devices[name].flags &&
			devices[name].flags.pointtopoint === true;

		if (!target || !devices[target] || devices[target].up !== true || !counters(devices, target) ||
			(group && !group.members.some(function(info) { return info.up === true; })))
			return;

		((group ? group.lower : !pointToPoint) ? lower : fallback)[target] = true;
	}

	interfaces.forEach(function(info) {
		if (!info || typeof(info.interface) != 'string' || excludedNetworks[info.interface] ||
			(!zoneNetworks[info.interface] && (!info.data || info.data.zone != zone.name)) ||
			(uci.get('network', info.interface, 'defaultroute') == '0' && !hasDefaultRoute(info)))
			return;

		var group = groups[info.interface];

		if (!group || info.up !== true)
			return;

		addCandidate(group);
	});

	var patterns = L.toArray(zone.device).filter(function(pattern) {
		return typeof(pattern) == 'string';
	}), positives = patterns.filter(function(pattern) {
		return pattern != '+' && pattern.charAt(0) != '!';
	}), negatives = patterns.filter(function(pattern) {
		return pattern.charAt(0) == '!';
	}).map(function(pattern) { return pattern.slice(1); });

	Object.keys(devices).forEach(function(name) {
		if (devices[name].up !== true || !counters(devices, name) ||
			!positives.some(function(pattern) { return matchesDevice(pattern, name); }) ||
			negatives.some(function(pattern) { return matchesDevice(pattern, name); }))
			return;

		var group = null;

		for (var i = 0; i < interfaces.length && !group; i++) {
			var info = interfaces[i];

			if (info && (info.device == name || info.l3_device == name))
				group = groups[info.interface];
		}

		addCandidate(group, name);
	});

	var names = Object.keys(Object.keys(lower).length ? lower : fallback).sort(L.naturalCompare);

	return {
		names: names,
		available: names.every(function(name) { return counters(devices, name) != null; })
	};
}

function connectionCounts(data, lines, devices, wan) {
	var counts = {}, prefixes = [], addresses = new Map(), local = new Set(), parsed = new Map(),
	    transit = {};

	function address(text) {
		if (typeof(text) != 'string')
			return null;
		if (!parsed.has(text))
			parsed.set(text, text.indexOf(':') >= 0 ? validation.parseIPv6(text) : validation.parseIPv4(text));
		return parsed.get(text);
	}

	function addAddress(item, key) {
		var ip = address(item.address), mask = address(item.netmask);
		if (!ip)
			return;
		var token = ip.join(','), owners = addresses.get(token) || new Set();
		local.add(token);
		if (key == null)
			return;
		owners.add(key);
		addresses.set(token, owners);
		counts[key] = 0;
		if (!mask || mask.length != ip.length)
			return;
		var bits = mask.map(function(word) { return word.toString(2).padStart(ip.length == 4 ? 8 : 16, '0'); }).join('');
		if (!/^1+0*$/.test(bits))
			return;
		prefixes.push({ key: key, ip: ip, mask: mask, length: bits.indexOf('0') < 0 ? bits.length : bits.indexOf('0') });
	}

	Object.keys(devices).forEach(function(name) {
		L.toArray(devices[name].ipaddrs).concat(L.toArray(devices[name].ip6addrs)).forEach(function(item) {
			if (item)
				addAddress(item, null);
		});
	});
	lines.forEach(function(line) {
		counts[line.key] = null;
		if (!line.connected)
			return;
		line.aliases.forEach(function(name) {
			var device = devices[name] || {};
			L.toArray(device.ipaddrs).concat(L.toArray(device.ip6addrs)).forEach(function(item) {
				if (item)
					addAddress(item, line.key);
			});
		});
		if (wan.names.indexOf(line.device) >= 0 || line.members.some(hasDefaultRoute))
			transit[line.key] = true;
	});

	function owners(ip) {
		var exact = addresses.get(ip.join(','));
		if (exact)
			return Array.from(exact);
		var best = -1, matches = new Set();
		prefixes.forEach(function(prefix) {
			if (prefix.ip.length != ip.length || prefix.length < best ||
				!ip.every(function(word, i) { return (word & prefix.mask[i]) == (prefix.ip[i] & prefix.mask[i]); }))
				return;
			if (prefix.length > best)
				matches.clear();
			best = prefix.length;
			matches.add(prefix.key);
		});
		return Array.from(matches);
	}

	var valid = typeof(data) == 'string';
	if (valid) {
		// Keep only per-refresh aggregates; conntrack tuples have no ingress/egress device fields.
		data.split('\n').forEach(function(record) {
			if (!record.trim())
				return;
			var family = /^(ipv4|ipv6)\s+\d+\s+\S+\s+\d+\s+/.exec(record),
			    src = [], dst = [], match, fields = /\b(src|dst)=(\S+)/g;
			while ((match = fields.exec(record)) != null)
				(match[1] == 'src' ? src : dst).push(address(match[2]));
			var endpoints = src.concat(dst);
			if (!family || src.length != 2 || dst.length != 2 || endpoints.some(function(ip) {
				return !ip || ip.length != (family[1] == 'ipv4' ? 4 : 8);
			})) {
				valid = false;
				return;
			}
			var matches = endpoints.map(owners), seen = new Set(),
			    internalPeers = matches[0].some(function(key) { return !transit[key]; }) &&
				    matches[1].some(function(key) { return !transit[key]; });
			matches.forEach(function(keys, index) {
				keys.forEach(function(key) {
					// Hairpin DNAT must not charge the WAN owning the translated public address.
					if (internalPeers && index >= 2 && transit[key])
						return;
					if (keys.length > 1)
						counts[key] = null;
					seen.add(key);
				});
			});
			var toRouter = local.has(dst[0].join(',')) && dst[0].join(',') == src[1].join(',');
			if (!toRouter && !internalPeers && !Array.from(seen).some(function(key) { return transit[key]; }))
				Object.keys(transit).forEach(function(key) { counts[key] = null; });
			seen.forEach(function(key) {
				if (counts[key] != null)
					counts[key]++;
			});
		});
	}

	lines.forEach(function(line) {
		counts[line.key] = !line.connected ? 0 : valid ? counts[line.key] : null;
	});
	return counts;
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
	if (!formatter || uptime == null || !(Number(localtime) > 0) || !(Number(uptime) >= 0))
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
				valueCell(nodes, 'connections', _('Connections', 'luci-app-monitor')),
				valueCell(nodes, 'rx', _('RX', 'luci-app-monitor')),
				valueCell(nodes, 'tx', _('TX', 'luci-app-monitor')),
				valueCell(nodes, 'totalRx', _('Total RX', 'luci-app-monitor')),
				valueCell(nodes, 'totalTx', _('Total TX', 'luci-app-monitor')),
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
		    cpu = cpuUsage(this.cpuSample, snapshot[3]),
		    definitions = lineDefinitions(allInterfaces, devices),
		    lines = definitions.lines,
		    wan = wanDevices(allInterfaces, devices, definitions.groups),
		    connections = connectionCounts(snapshot[5], lines, devices, wan),
		    now = performance.now(),
		    interfaceKey = JSON.stringify(lines.map(function(line) { return line.key; }));

		this.cpuSample = cpu.sample;
		this.metricNodes.cpu.data = cpu.value;

		var memory = system.memory || {};
		this.metricNodes.memory.data = Number(memory.total) > 0
			? '%.2f%%'.format((Number(memory.total) - Number(memory.free || 0)) * 100 / Number(memory.total))
			: '-';

		if (interfaceKey != this.interfaceKey) {
			this.interfaceKey = interfaceKey;
			this.buildInterfaceRows(lines);
		}

		var nextSamples = {};
		lines.forEach(L.bind(function(line) {
			var nodes = this.interfaceRows[line.key],
			    current = line.device ? counters(devices, line.device) : null,
			    status = line.connected ? _('Connected', 'luci-app-monitor') :
					(line.pending ? _('Pending', 'luci-app-monitor') :
						_('Disconnected', 'luci-app-monitor'));

			nodes.name.data = line.name == line.device
				? line.name : '%s (%s)'.format(line.name, line.device || '-');
			nodes.status.data = status;
			nodes.connections.data = connections[line.key] == null ? '-' : String(connections[line.key]);

			if (!current) {
				nodes.rx.data = line.connected ? '-' : formatBytes(0, true);
				nodes.tx.data = line.connected ? '-' : formatBytes(0, true);
				nodes.totalRx.data = '-';
				nodes.totalTx.data = '-';
				nodes.connected.data = line.connected
					? formatStartTime(this.dateFormatter, system.localtime, line.uptime) : '-';
				return;
			}

			var lineRates = line.connected
				? rates(this.lineSamples[line.key], current, line.device, now)
				: { rx: 0, tx: 0 };

			if (line.connected)
				nextSamples[line.key] = lineRates.sample;

			nodes.rx.data = formatBytes(lineRates.rx, true);
			nodes.tx.data = formatBytes(lineRates.tx, true);
			nodes.totalRx.data = formatBytes(current.rx, false);
			nodes.totalTx.data = formatBytes(current.tx, false);
			nodes.connected.data = line.connected
				? formatStartTime(this.dateFormatter, system.localtime, line.uptime) : '-';
		}, this));
		this.lineSamples = nextSamples;

		if (wan.available) {
			var total = { rx: 0, tx: 0 }, nextWanSamples = {};

			wan.names.forEach(L.bind(function(name) {
				var current = rates(this.wanSamples[name], counters(devices, name), name, now);
				total.rx += current.rx;
				total.tx += current.tx;
				nextWanSamples[name] = current.sample;
			}, this));

			this.wanSamples = nextWanSamples;
			this.metricNodes.download.data = formatBytes(total.rx, true);
			this.metricNodes.upload.data = formatBytes(total.tx, true);
		}
		else {
			this.wanSamples = {};
			this.metricNodes.download.data = '-';
			this.metricNodes.upload.data = '-';
		}

		if (this.pollSensors)
			this.updateSensors(snapshot[4]);
	},

	refresh: function() {
		if (this.refreshRequest)
			return this.refreshRequest;

		this.refreshRequest = loadSnapshot(this.pollSensors).then(L.bind(function(snapshot) {
			this.update(snapshot);
		}, this)).finally(L.bind(function() {
			this.refreshRequest = null;
		}, this));

		return this.refreshRequest;
	},

	handleIntervalChange: function(ev) {
		var interval = Number(ev.target.value);

		interval = isFinite(interval)
			? Math.min(60, Math.max(1, Math.floor(interval))) : 3;
		ev.target.value = String(interval);

		if (interval == this.pollInterval)
			return;

		this.pollInterval = interval;
		poll.remove(this.pollCallback);
		poll.add(this.pollCallback, interval);
		this.pollCallback();
	},

	render: function(data) {
		this.metricNodes = {};
		this.interfaceRows = {};
		this.sensorNodes = {};
		this.lineSamples = {};
		this.wanSamples = {};
		this.cpuSample = null;
		this.pollSensors = true;
		this.sensorFailures = 0;
		this.interfaceKey = null;
		this.sensorKey = null;
		this.pollInterval = 3;
		this.refreshRequest = null;
		this.pollCallback = L.bind(this.refresh, this);

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

		var intervals = [];
		for (var second = 1; second <= 60; second++)
			intervals.push(E('option', { 'value': second }, second));

		var intervalSelect = E('select', {
			'id': 'monitor-refresh-interval',
			'class': 'cbi-input-select',
			'change': L.bind(this.handleIntervalChange, this)
		}, intervals);
		intervalSelect.value = '3';

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
			E('div', { 'class': 'cbi-value' }, [
				E('label', {
					'class': 'cbi-value-title',
					'for': 'monitor-refresh-interval'
				}, _('Refresh Interval (seconds)', 'luci-app-monitor')),
				E('div', { 'class': 'cbi-value-field' }, intervalSelect)
			]),
			E('table', { 'class': 'table' }, [ summaryBody, this.sensorBody ]),
			E('h3', _('Interfaces', 'luci-app-monitor')),
			E('table', { 'class': 'table' }, [
				E('thead', {}, E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th left' }, _('Interface Name', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Status', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Connections', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('RX', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('TX', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Total RX', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Total TX', 'luci-app-monitor')),
					E('th', { 'class': 'th left' }, _('Connected Since', 'luci-app-monitor'))
				])),
				this.interfaceBody
			])
		]);

		this.update(data[3]);
		poll.add(this.pollCallback, this.pollInterval);

		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
