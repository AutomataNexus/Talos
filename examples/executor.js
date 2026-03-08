/**
 * NexusEdge Example Executor
 *
 * Author: Andrew Jewell Sr — AutomataNexus
 * Updated: March 8, 2026
 *
 * DISCLAIMER: This software is provided "as is", without warranty of any kind,
 * express or implied. Use at your own risk. The author and AutomataNexus assume
 * no liability for any damages resulting from the use of this software.
 * You are solely responsible for validating that this code is appropriate for
 * your application and meets all applicable safety requirements.
 *
 * Reads sensor data from the hardware daemon, runs control logic,
 * and writes outputs back to the daemon. This is the bridge between
 * your logic file and the physical I/O.
 *
 * Hardware Daemon API (default port 6100):
 *   GET  /megabas/analog_inputs      — raw voltages [ch1..ch8]
 *   GET  /megabas/resistance_10k     — 10K thermistor ohms [ch1..ch8]
 *   GET  /megabas/resistance_1k      — 1K thermistor ohms [ch1..ch8]
 *   GET  /megabas/dry_contacts       — dry contact states [ch1..ch8]
 *   POST /megabas/analog_output      — {stack, channel, value} 0-10V
 *   POST /megabas/triac              — {stack, channel, state} true/false
 *
 * Thermistor Conversion:
 *   The daemon provides raw resistance. This executor converts to °F
 *   using the Steinhart-Hart equation (B-parameter form).
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────────
const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = 6100;
const CYCLE_MS = 5000;  // Control loop interval

const LOGIC_FILE = path.join(__dirname, 'logic', 'equipment', 'temperature_control.js');

// ── Thermistor Conversion ──────────────────────────────────────────
function resistanceToTempF(ohms, type) {
  if (ohms <= 0 || ohms > 200000) return null;

  var T0 = 298.15; // 25°C in Kelvin
  var R0, B;

  if (type === '1k') {
    R0 = 1000;
    B = 3380;
  } else {
    // Default 10K
    R0 = 10000;
    B = 3950;
  }

  var tempK = 1 / (1 / T0 + (1 / B) * Math.log(ohms / R0));
  var tempF = (tempK - 273.15) * 9 / 5 + 32;
  return Math.round(tempF * 100) / 100;
}

// ── HTTP Helpers ───────────────────────────────────────────────────
function daemonGet(urlPath) {
  return new Promise(function(resolve, reject) {
    var req = http.get({
      hostname: DAEMON_HOST, port: DAEMON_PORT,
      path: urlPath, timeout: 3000
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + urlPath)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout: ' + urlPath)); });
  });
}

function daemonPost(urlPath, body) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(body);
    var req = http.request({
      hostname: DAEMON_HOST, port: DAEMON_PORT,
      path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 2000
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(d); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout: ' + urlPath)); });
    req.write(data);
    req.end();
  });
}

// ── Logic File Loader (hot-reload on file change) ──────────────────
var logic = null;
var logicMtime = 0;

function loadLogic() {
  try {
    var stat = fs.statSync(LOGIC_FILE);
    if (stat.mtimeMs !== logicMtime) {
      delete require.cache[require.resolve(LOGIC_FILE)];
      logic = require(LOGIC_FILE);
      logicMtime = stat.mtimeMs;
      console.log('[Executor] Logic loaded: ' + path.basename(LOGIC_FILE));
    }
  } catch (err) {
    console.error('[Executor] Failed to load logic:', err.message);
  }
}

// ── Read Inputs from Daemon ────────────────────────────────────────
async function readInputs() {
  // Fetch all sensor data in parallel
  var [res10k, dryContacts] = await Promise.all([
    daemonGet('/megabas/resistance_10k').catch(function() { return { values: [] }; }),
    daemonGet('/megabas/dry_contacts').catch(function() { return { values: [] }; }),
  ]);

  var r = res10k.values || [];
  var dc = dryContacts.values || [];

  // Map your physical wiring to named inputs
  // Adjust these channel assignments to match YOUR board wiring:
  //   CH1 (index 0) = Supply Air Temp (10K thermistor)
  //   CH2 (index 1) = Space Temp (10K thermistor)
  //   CH3 (index 2) = Outdoor Air Temp (10K thermistor)
  //   DC1 (index 0) = Fan status dry contact
  return {
    supplyTemp:  resistanceToTempF(r[0], '10k'),
    spaceTemp:   resistanceToTempF(r[1], '10k'),
    outdoorTemp: resistanceToTempF(r[2], '10k'),
    fanStatus:   dc[0] || false,
    setpoint:    68,  // Replace with your setpoint source (database, API, etc.)
  };
}

// ── Write Outputs to Daemon ────────────────────────────────────────
async function writeOutputs(outputs) {
  if (!outputs || !outputs.megabas0) return;

  var mb = outputs.megabas0;

  // Write triacs
  if (mb.TR1 !== undefined) {
    await daemonPost('/megabas/triac', { stack: 0, channel: 1, state: Boolean(mb.TR1) })
      .catch(function(err) { console.error('[Executor] TR1 write error:', err.message); });
  }

  // Write analog outputs
  var aoChannels = { AO1: 1, AO2: 2, AO3: 3, AO4: 4 };
  for (var key in aoChannels) {
    if (mb[key] !== undefined) {
      await daemonPost('/megabas/analog_output', {
        stack: 0, channel: aoChannels[key], value: parseFloat(mb[key].toFixed(2))
      }).catch(function(err) { console.error('[Executor] ' + key + ' write error:', err.message); });
    }
  }
}

// ── Safe Shutdown ──────────────────────────────────────────────────
async function safeShutdown() {
  console.log('[Executor] Safe shutdown — setting outputs to safe state');
  try {
    await daemonPost('/megabas/triac', { stack: 0, channel: 1, state: false });    // Fan off
    await daemonPost('/megabas/analog_output', { stack: 0, channel: 1, value: 0 });  // HW open (safe)
    await daemonPost('/megabas/analog_output', { stack: 0, channel: 2, value: 10 }); // CW closed
    await daemonPost('/megabas/analog_output', { stack: 0, channel: 3, value: 0 });  // OA closed
  } catch (err) {
    console.error('[Executor] Safe shutdown error:', err.message);
  }
}

// ── Main Control Loop ──────────────────────────────────────────────
var cycleCount = 0;

async function controlCycle() {
  try {
    // 1. Hot-reload logic if file changed
    loadLogic();
    if (!logic) return;

    // 2. Read all inputs from daemon
    var inputs = await readInputs();

    // 3. Validate — skip cycle if critical sensors are missing
    if (inputs.supplyTemp === null) {
      console.warn('[Executor] No supply temp reading — skipping cycle');
      return;
    }

    // 4. Execute control logic
    var result = logic.execute(inputs);

    // 5. Write outputs to daemon
    if (result && result.outputs) {
      await writeOutputs(result.outputs);
    }

    cycleCount++;
  } catch (err) {
    console.error('[Executor] Cycle error:', err.message);
  }
}

// ── Startup ────────────────────────────────────────────────────────
console.log('[Executor] Starting — cycle interval: ' + CYCLE_MS + 'ms');
console.log('[Executor] Logic file: ' + LOGIC_FILE);
console.log('[Executor] Daemon: http://' + DAEMON_HOST + ':' + DAEMON_PORT);

loadLogic();

var timer = setInterval(controlCycle, CYCLE_MS);

// Run first cycle immediately
controlCycle();

// Graceful shutdown
process.on('SIGTERM', async function() {
  console.log('[Executor] SIGTERM');
  clearInterval(timer);
  await safeShutdown();
  process.exit(0);
});

process.on('SIGINT', async function() {
  console.log('[Executor] SIGINT');
  clearInterval(timer);
  await safeShutdown();
  process.exit(0);
});
