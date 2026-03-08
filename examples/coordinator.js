/**
 * NexusEdge Example Coordinator
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
 * Manages one or more executors. Handles lifecycle (start/stop),
 * safe shutdown on signals, and health monitoring.
 *
 * For single-equipment controllers, you can skip this and run the
 * executor directly. The coordinator is useful when one Pi controls
 * multiple pieces of equipment (e.g., AHU + pumps + boiler).
 *
 * Usage:
 *   node coordinator.js
 *   # or via PM2:
 *   pm2 start coordinator.js --name my-coordinator
 */

const { fork } = require('child_process');
const path = require('path');
const http = require('http');

// ── Configuration ──────────────────────────────────────────────────

const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = 6100;

// Define your equipment here. Each entry spawns a separate executor.
// For single-equipment setups, just list one.
const EQUIPMENT = [
  {
    name: 'ahu-1',
    executor: './executor.js',
    enabled: true,
  },
  // Add more equipment as needed:
  // {
  //   name: 'boiler-1',
  //   executor: './boiler-executor.js',
  //   enabled: true,
  // },
];

// ── State ──────────────────────────────────────────────────────────

var children = {};       // name → child process
var isShuttingDown = false;

// ── Daemon Health Check ────────────────────────────────────────────

function checkDaemon() {
  return new Promise(function(resolve) {
    var req = http.get({
      hostname: DAEMON_HOST, port: DAEMON_PORT,
      path: '/health', timeout: 2000
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve(true); });
    });
    req.on('error', function() { resolve(false); });
    req.on('timeout', function() { req.destroy(); resolve(false); });
  });
}

// ── Safe All Outputs ───────────────────────────────────────────────

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
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function safeAllOutputs() {
  console.log('[Coordinator] Setting all outputs to safe state');
  try {
    // Turn off all triacs (4 channels)
    for (var t = 1; t <= 4; t++) {
      await daemonPost('/megabas/triac', { stack: 0, channel: t, state: false });
    }
    // Set all analog outputs to 0V
    for (var a = 1; a <= 4; a++) {
      await daemonPost('/megabas/analog_output', { stack: 0, channel: a, value: 0 });
    }
    console.log('[Coordinator] All outputs safed');
  } catch (err) {
    console.error('[Coordinator] Safe output error:', err.message);
  }
}

// ── Executor Management ────────────────────────────────────────────

function startExecutor(equipment) {
  if (!equipment.enabled) return;
  if (children[equipment.name]) return;

  var script = path.resolve(__dirname, equipment.executor);
  console.log('[Coordinator] Starting ' + equipment.name + ' → ' + script);

  var child = fork(script, [], {
    env: Object.assign({}, process.env, {
      EQUIPMENT_NAME: equipment.name,
    }),
    stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
  });

  child.on('exit', function(code) {
    console.log('[Coordinator] ' + equipment.name + ' exited (code ' + code + ')');
    delete children[equipment.name];

    // Auto-restart after 5 seconds (unless shutting down)
    if (!isShuttingDown && equipment.enabled) {
      console.log('[Coordinator] Restarting ' + equipment.name + ' in 5s...');
      setTimeout(function() { startExecutor(equipment); }, 5000);
    }
  });

  child.on('error', function(err) {
    console.error('[Coordinator] ' + equipment.name + ' error:', err.message);
  });

  children[equipment.name] = child;
}

function stopExecutor(name) {
  var child = children[name];
  if (!child) return Promise.resolve();

  return new Promise(function(resolve) {
    console.log('[Coordinator] Stopping ' + name);
    child.once('exit', resolve);
    child.kill('SIGTERM');

    // Force kill after 5 seconds
    setTimeout(function() {
      if (children[name]) {
        console.log('[Coordinator] Force killing ' + name);
        child.kill('SIGKILL');
        resolve();
      }
    }, 5000);
  });
}

async function stopAll() {
  var names = Object.keys(children);
  for (var i = 0; i < names.length; i++) {
    await stopExecutor(names[i]);
  }
}

// ── Graceful Shutdown ──────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[Coordinator] ' + signal + ' — shutting down');

  // 1. Stop all executors
  await stopAll();

  // 2. Safe all hardware outputs
  await safeAllOutputs();

  console.log('[Coordinator] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', function() { shutdown('SIGTERM'); });
process.on('SIGINT', function() { shutdown('SIGINT'); });

// ── Startup ────────────────────────────────────────────────────────

async function main() {
  console.log('[Coordinator] Starting NexusEdge Coordinator');
  console.log('[Coordinator] Equipment: ' + EQUIPMENT.filter(function(e) { return e.enabled; }).map(function(e) { return e.name; }).join(', '));

  // Wait for daemon to be available
  var attempts = 0;
  while (attempts < 30) {
    var ok = await checkDaemon();
    if (ok) break;
    attempts++;
    console.log('[Coordinator] Waiting for hardware daemon... (' + attempts + '/30)');
    await new Promise(function(r) { setTimeout(r, 2000); });
  }

  if (attempts >= 30) {
    console.error('[Coordinator] Hardware daemon not available — exiting');
    process.exit(1);
  }

  console.log('[Coordinator] Hardware daemon online');

  // Start all enabled executors
  EQUIPMENT.forEach(function(eq) {
    startExecutor(eq);
  });

  // Health check every 60 seconds
  setInterval(function() {
    var running = Object.keys(children);
    console.log('[Coordinator] Health: ' + running.length + ' executor(s) running [' + running.join(', ') + ']');
  }, 60000);
}

main().catch(function(err) {
  console.error('[Coordinator] Fatal:', err.message);
  process.exit(1);
});
