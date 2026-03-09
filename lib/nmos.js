const express = require('express');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const Bonjour = require('bonjour-service').Bonjour;

// Persistent UUIDs (generated once per run)
const nodeId = uuidv4();
const deviceId = uuidv4();
const sourceId = uuidv4();
const flowId = uuidv4();
const senderId = uuidv4();

let nmosConfig = {};
let bonjour;
let server;

function getMacAddress(addr) {
	const nets = require('os').networkInterfaces();
	for (const name in nets) {
		for (const net of nets[name]) {
			if (net.family === 'IPv4' && net.address === addr && net.mac && net.mac !== '00:00:00:00:00:00') {
				return net.mac.replace(/:/g, '-');
			}
		}
	}
	return '00-00-00-00-00-00';
}

function buildNode() {
	return {
		id: nodeId,
		version: nmosConfig.version,
		label: nmosConfig.streamName,
		description: 'AES67 Sender Node',
		tags: {},
		href: `http://${nmosConfig.addr}:${nmosConfig.httpPort}/`,
		api: {
			versions: ['v1.3'],
			endpoints: [{
				host: nmosConfig.addr,
				port: nmosConfig.httpPort,
				protocol: 'http'
			}]
		},
		caps: {},
		services: [],
		clocks: [{
			name: 'clk0',
			ref_type: 'ptp',
			traceable: false,
			version: 'IEEE1588-2008',
			gmid: nmosConfig.ptpMaster.replace(/:.*$/, ''),
			locked: true
		}],
		interfaces: [{
			chassis_id: null,
			port_id: getMacAddress(nmosConfig.addr),
			name: 'eth0'
		}]
	};
}

function buildDevice() {
	return {
		id: deviceId,
		version: nmosConfig.version,
		label: nmosConfig.streamName,
		description: 'AES67 Sender Device',
		tags: {},
		type: 'urn:x-nmos:device:generic',
		node_id: nodeId,
		senders: [senderId],
		receivers: [],
		controls: [{
			href: `http://${nmosConfig.addr}:${nmosConfig.httpPort}/x-nmos/connection/v1.1/`,
			type: 'urn:x-nmos:control:sr-ctrl/v1.1'
		}]
	};
}

function buildSource() {
	return {
		id: sourceId,
		version: nmosConfig.version,
		label: nmosConfig.streamName,
		description: 'Audio source',
		tags: {},
		caps: {},
		device_id: deviceId,
		parents: [],
		clock_name: 'clk0',
		grain_rate: {
			numerator: nmosConfig.samplerate,
			denominator: 1
		},
		channels: buildChannelList(),
		format: 'urn:x-nmos:format:audio'
	};
}

function buildFlow() {
	return {
		id: flowId,
		version: nmosConfig.version,
		label: nmosConfig.streamName,
		description: 'Audio flow',
		tags: {},
		device_id: deviceId,
		source_id: sourceId,
		parents: [],
		grain_rate: {
			numerator: nmosConfig.samplerate,
			denominator: 1
		},
		sample_rate: {
			numerator: nmosConfig.samplerate,
			denominator: 1
		},
		media_type: 'audio/L24',
		bit_depth: 24,
		format: 'urn:x-nmos:format:audio'
	};
}

function buildSender() {
	return {
		id: senderId,
		version: nmosConfig.version,
		label: nmosConfig.streamName,
		description: 'AES67 audio sender',
		tags: {},
		flow_id: flowId,
		transport: 'urn:x-nmos:transport:rtp.mcast',
		device_id: deviceId,
		manifest_href: `http://${nmosConfig.addr}:${nmosConfig.httpPort}/sdp.sdp`,
		interface_bindings: ['eth0'],
		subscription: {
			receiver_id: null,
			active: true
		}
	};
}

function buildChannelList() {
	const channels = [];
	const labels = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lss', 'Rss'];
	for (let i = 0; i < nmosConfig.channels; i++) {
		channels.push({
			label: labels[i] || `Ch${i + 1}`,
			symbol: labels[i] || `Ch${i + 1}`
		});
	}
	return channels;
}

function buildSDP() {
	return [
		'v=0',
		`o=- ${nmosConfig.sessID} ${nmosConfig.sessVersion} IN IP4 ${nmosConfig.addr}`,
		`s=${nmosConfig.streamName}`,
		`c=IN IP4 ${nmosConfig.multicastAddr}/32`,
		't=0 0',
		`a=clock-domain:PTPv2 ${nmosConfig.ptpDomain}`,
		'm=audio 5004 RTP/AVP 96',
		`a=rtpmap:96 ${nmosConfig.encoding}/${nmosConfig.samplerate}/${nmosConfig.channels}`,
		'a=sync-time:0',
		'a=framecount:48',
		'a=ptime:1',
		'a=mediaclk:direct=0',
		`a=ts-refclk:ptp=IEEE1588-2008:${nmosConfig.ptpMaster}`,
		'a=recvonly',
		''
	].join('\r\n');
}

function buildTransportParams() {
	return [{
		source_ip: nmosConfig.addr,
		destination_ip: nmosConfig.multicastAddr,
		destination_port: 5004,
		source_port: 'auto',
		rtp_enabled: true,
		fec_enabled: false,
		fec_destination_ip: 'auto',
		fec_mode: 'auto',
		fec1D_destination_port: 'auto',
		fec2D_destination_port: 'auto',
		fec1D_source_port: 'auto',
		fec2D_source_port: 'auto',
		rtcp_destination_ip: 'auto',
		rtcp_destination_port: 'auto',
		rtcp_source_port: 'auto'
	}];
}

// IS-04 Node API
function setupIS04(app) {
	app.get('/x-nmos', (req, res) => {
		res.json(['node/', 'connection/']);
	});

	app.get('/x-nmos/node', (req, res) => {
		res.json(['v1.3/']);
	});

	app.get('/x-nmos/node/v1.3', (req, res) => {
		res.json(['self/', 'sources/', 'flows/', 'devices/', 'senders/', 'receivers/']);
	});

	app.get('/x-nmos/node/v1.3/self', (req, res) => {
		res.json(buildNode());
	});

	app.get('/x-nmos/node/v1.3/sources', (req, res) => {
		res.json([buildSource()]);
	});

	app.get('/x-nmos/node/v1.3/sources/:id', (req, res) => {
		if (req.params.id === sourceId) return res.json(buildSource());
		res.status(404).json({ code: 404, error: 'Not found' });
	});

	app.get('/x-nmos/node/v1.3/flows', (req, res) => {
		res.json([buildFlow()]);
	});

	app.get('/x-nmos/node/v1.3/flows/:id', (req, res) => {
		if (req.params.id === flowId) return res.json(buildFlow());
		res.status(404).json({ code: 404, error: 'Not found' });
	});

	app.get('/x-nmos/node/v1.3/devices', (req, res) => {
		res.json([buildDevice()]);
	});

	app.get('/x-nmos/node/v1.3/devices/:id', (req, res) => {
		if (req.params.id === deviceId) return res.json(buildDevice());
		res.status(404).json({ code: 404, error: 'Not found' });
	});

	app.get('/x-nmos/node/v1.3/senders', (req, res) => {
		res.json([buildSender()]);
	});

	app.get('/x-nmos/node/v1.3/senders/:id', (req, res) => {
		if (req.params.id === senderId) return res.json(buildSender());
		res.status(404).json({ code: 404, error: 'Not found' });
	});

	app.get('/x-nmos/node/v1.3/receivers', (req, res) => {
		res.json([]);
	});
}

// IS-05 Connection API
function setupIS05(app) {
	app.get('/x-nmos/connection', (req, res) => {
		res.json(['v1.0/', 'v1.1/']);
	});

	// Support both v1.0 and v1.1
	const versions = ['v1.0', 'v1.1'];

	app.get('/x-nmos/connection/v1.1', (req, res) => {
		res.json(['single/']);
	});

	for (const ver of versions) {

	app.get(`/x-nmos/connection/${ver}/single`, (req, res) => {
		res.json(['senders/', 'receivers/']);
	});

	app.get(`/x-nmos/connection/${ver}/single/senders`, (req, res) => {
		res.json([`${senderId}/`]);
	});

	app.get(`/x-nmos/connection/${ver}/single/senders/:id`, (req, res) => {
		if (req.params.id !== senderId) return res.status(404).json({ code: 404, error: 'Not found' });
		res.json(['constraints/', 'staged/', 'active/', 'transportfile/', 'transporttype/']);
	});

	app.get(`/x-nmos/connection/${ver}/single/senders/:id/constraints`, (req, res) => {
		if (req.params.id !== senderId) return res.status(404).json({ code: 404, error: 'Not found' });
		res.json([{
			source_ip: { enum: [nmosConfig.addr] },
			destination_ip: {},
			destination_port: { enum: [5004] },
			source_port: {},
			rtp_enabled: { enum: [true] }
		}]);
	});

	app.get(`/x-nmos/connection/${ver}/single/senders/:id/staged`, (req, res) => {
		if (req.params.id !== senderId) return res.status(404).json({ code: 404, error: 'Not found' });
		res.json({
			sender_id: senderId,
			master_enable: true,
			activation: { mode: null, requested_time: null, activation_time: null },
			transport_params: buildTransportParams()
		});
	});

	app.get(`/x-nmos/connection/${ver}/single/senders/:id/active`, (req, res) => {
		if (req.params.id !== senderId) return res.status(404).json({ code: 404, error: 'Not found' });
		res.json({
			sender_id: senderId,
			master_enable: true,
			activation: { mode: 'activate_immediate', requested_time: null, activation_time: nmosConfig.version + ':0' },
			transport_params: buildTransportParams()
		});
	});

	app.get(`/x-nmos/connection/${ver}/single/senders/:id/transportfile`, (req, res) => {
		if (req.params.id !== senderId) return res.status(404).json({ code: 404, error: 'Not found' });
		res.set('Content-Type', 'application/sdp');
		res.send(buildSDP());
	});

	app.get(`/x-nmos/connection/${ver}/single/senders/:id/transporttype`, (req, res) => {
		if (req.params.id !== senderId) return res.status(404).json({ code: 404, error: 'Not found' });
		res.json('urn:x-nmos:transport:rtp.mcast');
	});

	app.get(`/x-nmos/connection/${ver}/single/receivers`, (req, res) => {
		res.json([]);
	});

	} // end for versions
}

exports.start = function(config) {
	nmosConfig = config;
	nmosConfig.version = Math.floor(Date.now() / 1000) + ':0';

	const app = express();

	// Direct SDP endpoint for manifest_href
	app.get('/sdp.sdp', (req, res) => {
		res.set('Content-Type', 'application/sdp');
		res.send(buildSDP());
	});

	setupIS04(app);
	setupIS05(app);

	server = app.listen(nmosConfig.httpPort, nmosConfig.addr, () => {
		console.log(`NMOS Node API running at http://${nmosConfig.addr}:${nmosConfig.httpPort}/x-nmos/node/v1.3/`);
		console.log(`NMOS Connection API running at http://${nmosConfig.addr}:${nmosConfig.httpPort}/x-nmos/connection/v1.1/`);
	});

	// mDNS advertisement for peer-to-peer discovery
	bonjour = new Bonjour();
	bonjour.publish({
		name: nmosConfig.streamName,
		type: 'nmos-node',
		protocol: 'tcp',
		port: nmosConfig.httpPort,
		txt: {
			api_ver: 'v1.3',
			api_proto: 'http'
		}
	});

	console.log(`NMOS mDNS service advertised as "${nmosConfig.streamName}"`);
};

exports.stop = function() {
	if (server) server.close();
	if (bonjour) bonjour.destroy();
};
