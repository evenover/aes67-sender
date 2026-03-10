// AES67 sender — full GStreamer pipeline
// GStreamer handles: WASAPI capture, RTP packetization, multicast send (all in C, no GC/jitter)
// Node.js handles: PTP sync, SDP/SAP announcements, NMOS (not in audio path)
//
// Requires: GStreamer installed with wasapi2src, audioconvert, rtpL24pay, udpsink
// Usage: node aes67 -d <wasapi-device-id> -m 239.254.151.11 --address 10.151.5.227 -c 2 --ptp-domain 84 --nmos --ttl 5 -v

const os = require('os');
const dgram = require('dgram');
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

let ttl = 1;
if(program.ttl){
	ttl = parseInt(program.ttl);
	logger('Set multicast TTL to', ttl);
}

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

logger('Trying to sync to PTP master.');

//ptp sync timeout
setTimeout(function(){
	if(!ptpMaster){
		console.error('Could not sync to PTP master. Aborting.');
		process.exit();
	}
}, 10000);

//init PTP client, then start full GStreamer pipeline
ptpv2.init(addr, domainNumber, function(){
	ptpMaster = ptpv2.ptp_master();
	logger('Synced to', ptpMaster, 'successfully');

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

	//build GStreamer args (without timestamp-offset and sink — added per launch)
	function buildGstBase(){
		let args = [];

		if(program.device){
			args.push('wasapi2src', 'device=' + program.device);
		}else{
			args.push('wasapi2src');
		}

		if(program.loopback){
			args.push('loopback=true');
		}

		if(program.lowLatency){
			args.push('low-latency=true');
		}

		args.push(
			'!',
			'audioconvert', '!',
			'audioresample', '!',
			'audio/x-raw,format=S24BE,rate=' + samplerate + ',channels=' + audioChannels, '!',
			'rtpL24pay',
			'pt=96',
			'min-ptime=' + (ptime * 1000000),
			'max-ptime=' + (ptime * 1000000),
			'ssrc=' + ssrc
		);

		return args;
	}

	// Warm-probe timestamp calibration:
	// 1. Run two localhost probes (cold then warm) to measure GStreamer startup time
	// 2. Use warm startup measurement to predict real pipeline offset
	// 3. Verify by listening on own multicast after launch

	function ptpSamplesNow(){
		let t = ptpv2.ptp_time();
		return ((t[0] * samplerate) + Math.round((t[1] * samplerate) / 1e9)) % 0x100000000;
	}

	let activeGst = null;

	// Measure GStreamer startup time via localhost probe
	function measureStartup(label, callback){
		let port = 19999;
		let sock = dgram.createSocket('udp4');
		let done = false;

		sock.bind(port, '127.0.0.1', function(){
			let args = buildGstBase();
			args.push(
				'timestamp-offset=0', '!',
				'udpsink', 'host=127.0.0.1', 'port=' + port,
				'sync=false', 'async=false'
			);

			let t = Date.now();
			let gst = spawn('gst-launch-1.0', args, {
				stdio: ['ignore', 'pipe', 'pipe']
			});

			try { os.setPriority(gst.pid, os.constants.priority.PRIORITY_HIGH); } catch(e){}

			sock.on('message', function(){
				if(done) return;
				done = true;
				let ms = Date.now() - t;
				gst.kill('SIGTERM');
				sock.close();
				logger(label + ': ' + ms + 'ms');
				gst.once('close', function(){ callback(ms); });
			});

			gst.on('error', function(err){
				console.error('Probe failed:', err.message);
				process.exit(1);
			});

			gst.on('close', function(){
				if(!done){
					try { sock.close(); } catch(e){}
					console.error('Probe exited without producing audio. Check device.');
					process.exit(1);
				}
			});
		});
	}

	// Launch the real streaming pipeline
	function launchStream(timestampOffset){
		let gstArgs = buildGstBase();
		gstArgs.push(
			'timestamp-offset=' + timestampOffset,
			'!',
			'udpsink',
			'host=' + aes67Multicast,
			'port=5004',
			'multicast-iface=' + addr,
			'ttl-mc=' + ttl,
			'qos-dscp=46',
			'sync=false',
			'async=false'
		);

		logger('Launching stream, offset=' + timestampOffset);

		let spawnTime = Date.now();
		let gst = spawn('gst-launch-1.0', gstArgs, {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		activeGst = gst;

		try {
			os.setPriority(gst.pid, os.constants.priority.PRIORITY_HIGH);
			logger('GStreamer process priority set to HIGH');
		} catch(e){
			logger('Could not set GStreamer priority:', e.message);
		}

		gst.stdout.on('data', function(data){
			let msg = data.toString().trim();
			if(msg) logger('[GStreamer]', msg);
		});
		gst.stderr.on('data', function(data){
			let msg = data.toString().trim();
			if(msg) logger('[GStreamer]', msg);
		});
		gst.on('error', function(err){
			console.error('GStreamer failed:', err.message);
			process.exit(1);
		});
		gst.on('close', function(code){
			console.log('GStreamer exited with code', code);
			process.exit(code || 0);
		});

		console.log('AES67 stream started (full GStreamer pipeline)');
		console.log('  Source:', addr);
		console.log('  Multicast:', aes67Multicast + ':5004');
		console.log('  Channels:', audioChannels);
		console.log('  SSRC:', ssrc);
		console.log('  Timestamp offset:', timestampOffset);

		// Verify alignment by listening for own multicast packets
		let sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
		let count = 0;
		let errorSum = 0;

		let timeout = setTimeout(function(){
			try { sock.close(); } catch(e){}
			if(count === 0) logger('Could not verify alignment (no packets received)');
		}, 10000);

		sock.on('message', function(buf){
			if(buf.length < 12 || buf.readUInt32BE(8) !== ssrc) return;
			count++;

			let err = ptpSamplesNow() - buf.readUInt32BE(4);
			if(err > 0x7FFFFFFF) err -= 0x100000000;
			if(err < -0x7FFFFFFF) err += 0x100000000;
			errorSum += err;

			if(count >= 20){
				clearTimeout(timeout);
				sock.close();
				let avgErr = Math.round(errorSum / 20);
				let errMs = avgErr / samplerate * 1000;
				let actualStartup = Date.now() - spawnTime;
				logger('Actual startup: ' + actualStartup + 'ms');
				logger('Timestamp error: ' + errMs.toFixed(1) + 'ms');
				if(Math.abs(errMs) > 16){
					logger('TIP: Use -l ' + Math.round(errMs) + ' to compensate on next launch');
				}
			}
		});

		sock.on('error', function(){
			clearTimeout(timeout);
			try { sock.close(); } catch(e){}
		});

		sock.bind(5004, function(){
			sock.addMembership(aes67Multicast, addr);
		});
	}

	// Graceful shutdown (registered once)
	process.on('SIGINT', function(){
		console.log('\nStopping...');
		if(activeGst) activeGst.kill('SIGTERM');
	});
	process.on('SIGTERM', function(){
		if(activeGst) activeGst.kill('SIGTERM');
	});

	// Calibrate: cold probe (warms WASAPI), then warm probe (accurate measurement)
	// Boost Node.js priority for PTP timing accuracy
	try { os.setPriority(0, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch(e){}

	logger('Calibrating GStreamer startup time...');
	measureStartup('Cold startup', function(coldMs){
		measureStartup('Warm startup', function(warmMs){
			let ptpNow = ptpSamplesNow();
			let comp = Math.round(warmMs * samplerate / 1000);
			let offset = (Math.floor((ptpNow + comp) / fpp) * fpp - latencyOffsetSamples + 0x100000000) % 0x100000000;
			logger('Calibration: cold=' + coldMs + 'ms, warm=' + warmMs + 'ms, compensation=' + comp + ' samples');
			launchStream(offset);
		});
	});
});

