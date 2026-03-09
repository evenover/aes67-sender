// AES67 sender using GStreamer for audio capture and RTP streaming
// Node.js handles PTP sync, SDP/SAP announcements, and NMOS
//
// Requires: GStreamer installed with wasapi2src, audioconvert, rtpL24pay, udpsink
// Usage: node aes67 -d <wasapi-device-id> -m 239.254.151.11 --address 10.151.5.227 -c 2 --ptp-domain 84 --nmos --ttl 5 -v

const os = require('os');
const { spawn, execSync } = require('child_process');
const ptpv2 = require('ptpv2');
const sdp = require('./lib/sdp');
const nmos = require('./lib/nmos');
const { Command } = require('commander');

//command line options
const program = new Command();
program.version('2.0.0');
program.option('-v, --verbose', 'enable verbosity');
program.option('--devices', 'list GStreamer audio devices');
program.option('-d, --device <id>', 'WASAPI device ID (from --devices)');
program.option('-m, --mcast <address>', 'multicast address of AES67 stream');
program.option('-n, --streamname <name>', 'name of AES67 stream');
program.option('-c, --channels <number>', 'number of channels (default: 2)');
program.option('--address <address>', 'IPv4 address of network interface');
program.option('--ttl <number>', 'multicast TTL (default: 1)');
program.option('--ptp-domain <number>', 'PTP domain number (default: 0)');
program.option('--nmos', 'enable NMOS IS-04/IS-05 (peer-to-peer mDNS)');
program.option('--nmos-port <number>', 'NMOS HTTP port (default: 8090)');
program.option('-l, --latency <ms>', 'timestamp offset in ms (default: 0)');
program.option('--loopback', 'use WASAPI loopback capture (record what you hear)');
program.option('--low-latency', 'enable low-latency WASAPI mode');

program.parse(process.argv);

let logger = function(){};
if(program.verbose){
	logger = console.log;
}

//list GStreamer audio devices
if(program.devices){
	try {
		const output = execSync('gst-device-monitor-1.0 Audio/Source', {
			encoding: 'utf8',
			timeout: 10000
		});

		//parse device list into a readable format
		const devices = [];
		const blocks = output.split('Device found:');
		for(let i = 1; i < blocks.length; i++){
			const block = blocks[i];
			const nameMatch = block.match(/name\s*:\s*(.+)/);
			const idMatch = block.match(/device\.id\s*=\s*(.+)/);
			const descMatch = block.match(/wasapi2\.device\.description\s*=\s*(.+)/);
			const loopbackMatch = block.match(/wasapi2\.device\.loopback\s*=\s*(\w+)/);
			const actualNameMatch = block.match(/device\.actual-name\s*=\s*(.+)/);

			if(idMatch){
				devices.push({
					name: (descMatch ? descMatch[1].trim() : (nameMatch ? nameMatch[1].trim() : 'Unknown')),
					actualName: actualNameMatch ? actualNameMatch[1].trim() : '',
					id: idMatch[1].trim(),
					loopback: loopbackMatch ? loopbackMatch[1].trim() === 'true' : false
				});
			}
		}

		console.log('\nAvailable audio devices:\n');
		console.log('  #  Type       Device ID                                              Name');
		console.log('  -  ----       ---------                                              ----');
		for(let i = 0; i < devices.length; i++){
			const d = devices[i];
			const type = d.loopback ? 'loopback' : 'input   ';
			const name = d.actualName ? d.name + ' (' + d.actualName + ')' : d.name;
			console.log('  ' + i + '  ' + type + '   ' + d.id.padEnd(55) + name);
		}
		console.log('\nUsage: node aes67 -d "<device-id>" ...');
		console.log('For loopback devices, add --loopback');
	} catch(e) {
		console.error('Failed to list devices. Is GStreamer installed?');
		console.error(e.message);
	}
	process.exit();
}

//stream name
let streamName = os.hostname();
if(program.streamname){
	streamName = program.streamname;
}

//network addr
let addr;
if(program.address){
	addr = program.address;
}else{
	let interfaces = os.networkInterfaces();
	let interfaceNames = Object.keys(interfaces);
	let addresses = [];

	for(let i = 0; i < interfaceNames.length; i++){
		let iface = interfaces[interfaceNames[i]];
		for(let j = 0; j < iface.length; j++){
			if(iface[j].family == 'IPv4' && iface[j].address != '127.0.0.1'){
				addresses.push(iface[j].address);
			}
		}
	}

	if(addresses.length == 0){
		console.error('No network interface found!');
		process.exit();
	}

	addr = addresses[0];
	logger('Selected', addr, 'as network interface');
}

//audio channels
let audioChannels = 2;
if(program.channels){
	audioChannels = parseInt(program.channels);
}

//mcast addr
let aes67Multicast = '239.69.'+addr.split('.').splice(2).join('.');
if(program.mcast){
	aes67Multicast = program.mcast;
}

logger('Selected '+aes67Multicast+' as RTP multicast address.');

//AES67 params
const samplerate = 48000;
const ptime = 1;
const fpp = (samplerate / 1000) * ptime;
const encoding = 'L24';
const sessID = Math.round(Date.now() / 1000);
const sessVersion = sessID;
let ptpMaster;
let ssrc = sessID % 0x100000000;

//manual latency offset
let latencyOffset = 0;
if(program.latency){
	latencyOffset = parseFloat(program.latency);
	logger('Timestamp offset:', latencyOffset, 'ms');
}
const latencyOffsetSamples = Math.round(latencyOffset * samplerate / 1000);

let domainNumber = 0;
if(program.ptpDomain){
	domainNumber = parseInt(program.ptpDomain);
}

let ttl = 1;
if(program.ttl){
	ttl = parseInt(program.ttl);
}

logger('Trying to sync to PTP master.');

//ptp sync timeout
setTimeout(function(){
	if(!ptpMaster){
		console.error('Could not sync to PTP master. Aborting.');
		process.exit();
	}
}, 10000);

//init PTP client, then start GStreamer pipeline
ptpv2.init(addr, domainNumber, function(){
	ptpMaster = ptpv2.ptp_master();
	logger('Synced to', ptpMaster, 'successfully');

	//compute PTP-aligned RTP timestamp offset
	let ptpTime = ptpv2.ptp_time();
	let timestampRTP = ((ptpTime[0] * samplerate) + Math.round((ptpTime[1] * samplerate) / 1000000000)) % 0x100000000;
	let timestampOffset = (Math.floor(timestampRTP / fpp) * fpp - latencyOffsetSamples + 0x100000000) % 0x100000000;
	logger('PTP-aligned timestamp offset:', timestampOffset);

	//start SAP/SDP announcements
	sdp.start(addr, aes67Multicast, samplerate, audioChannels, encoding, streamName, sessID, sessVersion, ptpMaster, domainNumber);

	//start NMOS if enabled
	if(program.nmos){
		nmos.start({
			addr: addr,
			httpPort: program.nmosPort ? parseInt(program.nmosPort) : 8090,
			streamName: streamName,
			multicastAddr: aes67Multicast,
			samplerate: samplerate,
			channels: audioChannels,
			encoding: encoding,
			sessID: sessID,
			sessVersion: sessVersion,
			ptpMaster: ptpMaster,
			ptpDomain: domainNumber
		});
	}

	//build GStreamer pipeline
	let gstArgs = [];

	//audio source
	if(program.device){
		gstArgs.push('wasapi2src', 'device=' + program.device);
	}else{
		gstArgs.push('wasapi2src');
	}

	if(program.loopback){
		gstArgs.push('loopback=true');
	}

	if(program.lowLatency){
		gstArgs.push('low-latency=true');
	}

	gstArgs.push('!');

	//force format to match AES67 requirements
	gstArgs.push(
		'audioconvert', '!',
		'audioresample', '!',
		'audio/x-raw,format=S24BE,rate=' + samplerate + ',channels=' + audioChannels, '!',
		'rtpL24pay',
		'pt=96',
		'min-ptime=' + (ptime * 1000000),       // 1ms in nanoseconds
		'max-ptime=' + (ptime * 1000000),       // 1ms in nanoseconds
		'timestamp-offset=' + timestampOffset,
		'ssrc=' + ssrc,
		'!',
		'udpsink',
		'host=' + aes67Multicast,
		'port=5004',
		'multicast-iface=' + addr,
		'ttl=' + ttl,
		'sync=true',
		'async=false'
	);

	logger('GStreamer pipeline:', 'gst-launch-1.0', gstArgs.join(' '));

	//spawn GStreamer
	const gst = spawn('gst-launch-1.0', gstArgs, {
		stdio: ['ignore', 'pipe', 'pipe']
	});

	gst.stdout.on('data', function(data){
		const msg = data.toString().trim();
		if(msg) logger('[GStreamer]', msg);
	});

	gst.stderr.on('data', function(data){
		const msg = data.toString().trim();
		if(msg) logger('[GStreamer]', msg);
	});

	gst.on('error', function(err){
		console.error('Failed to start GStreamer:', err.message);
		console.error('Is gst-launch-1.0 in your PATH?');
		process.exit(1);
	});

	gst.on('close', function(code){
		console.log('GStreamer exited with code', code);
		process.exit(code || 0);
	});

	console.log('AES67 stream started via GStreamer');
	console.log('  Source:', addr);
	console.log('  Multicast:', aes67Multicast + ':5004');
	console.log('  Channels:', audioChannels);
	console.log('  SSRC:', ssrc);

	//graceful shutdown
	process.on('SIGINT', function(){
		console.log('\nStopping...');
		gst.kill('SIGTERM');
	});
	process.on('SIGTERM', function(){
		gst.kill('SIGTERM');
	});
});

