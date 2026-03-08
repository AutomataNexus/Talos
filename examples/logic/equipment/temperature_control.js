/**
 * NexusEdge Example Logic — Temperature Control
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
 * A basic heating/cooling control loop for an air handling unit.
 * Reads supply air temperature, modulates a hot water valve and
 * chilled water valve to maintain setpoint.
 *
 * This file is pure control logic — no I/O, no HTTP, no hardware calls.
 * The executor feeds it inputs and applies the outputs.
 *
 * Inputs (from executor):
 *   supplyTemp   — Supply air temperature (°F)
 *   spaceTemp    — Space/zone temperature (°F)
 *   outdoorTemp  — Outdoor air temperature (°F)
 *   setpoint     — Target supply temperature (°F)
 *   fanStatus    — Fan running dry contact (boolean)
 *
 * Outputs (to executor):
 *   megabas0.TR1  — Fan enable (triac, boolean)
 *   megabas0.AO1  — Hot water valve (0-10V, NO: 0V=open, 10V=closed)
 *   megabas0.AO2  — Chilled water valve (0-10V, NO: 0V=open, 10V=closed)
 *   megabas0.AO3  — Outside air damper (0-10V, DA: 0V=closed, 10V=open)
 */

// ── Configuration ──────────────────────────────────────────────────
var CONFIG = {
  // Safety limits
  FREEZE_LIMIT: 38,           // °F — shut down and open HW if supply drops below this
  HIGH_TEMP_LIMIT: 120,       // °F — shut down if supply exceeds this

  // Setpoint
  DEFAULT_SETPOINT: 68,       // °F — fallback if no setpoint provided
  HEATING_DEADBAND: 1.0,      // °F — below setpoint before heating engages
  COOLING_DEADBAND: 1.0,      // °F — above setpoint before cooling engages

  // Valve output limits
  MAX_HW_POSITION: 85,        // % — never open HW valve beyond this
  MAX_CW_POSITION: 100,       // % — max chilled water

  // Rate limiting — prevents valve slamming from thermal lag
  MAX_STEP: 1.5,              // % — max valve position change per cycle
                               // At 5s cycles: 0→85% takes ~4.7 minutes

  // Economizer
  ECON_ENABLE_TEMP: 55,       // °F OAT — enable free cooling above this
  ECON_DISABLE_TEMP: 75,      // °F OAT — disable free cooling above this
  MIN_OA_DAMPER: 15,          // % — minimum outside air for ventilation
};

// ── Persistent State (survives between cycles) ─────────────────────
var state = {
  hwPosition: 0,
  cwPosition: 0,
  oaDamperPosition: CONFIG.MIN_OA_DAMPER,
  prevSupplyTemp: null,
  lastLogTime: 0,
};

// ── Helpers ────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function num(v, fallback) {
  if (typeof v === 'number' && !isNaN(v)) return v;
  var n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

/**
 * Rate-limited proportional control.
 * Calculates a target position from error, then limits how fast
 * we can move toward it. This prevents oscillation caused by
 * thermal lag in hydronic systems.
 */
function rampToward(current, target, maxStep) {
  var delta = target - current;
  if (delta > maxStep) delta = maxStep;
  if (delta < -maxStep) delta = -maxStep;
  return current + delta;
}

// ── Main Control Logic ─────────────────────────────────────────────
function execute(inputs) {
  var supplyTemp = num(inputs.supplyTemp, 65);
  var spaceTemp  = num(inputs.spaceTemp, 72);
  var outdoorTemp = num(inputs.outdoorTemp, 65);
  var setpoint   = num(inputs.setpoint, CONFIG.DEFAULT_SETPOINT);
  var fanStatus  = Boolean(inputs.fanStatus);

  var now = Date.now();
  var error = supplyTemp - setpoint;  // positive = too hot, negative = too cold
  var mode = 'IDLE';

  // ── SAFETY: Freeze Protection ──
  if (supplyTemp < CONFIG.FREEZE_LIMIT) {
    state.hwPosition = CONFIG.MAX_HW_POSITION;
    state.cwPosition = 0;
    state.oaDamperPosition = 0;
    mode = 'FREEZE_PROTECT';

    return buildResult(mode, supplyTemp, spaceTemp, outdoorTemp, setpoint, false, now);
  }

  // ── SAFETY: High Temperature ──
  if (supplyTemp > CONFIG.HIGH_TEMP_LIMIT) {
    state.hwPosition = 0;
    state.cwPosition = CONFIG.MAX_CW_POSITION;
    state.oaDamperPosition = 100;
    mode = 'HIGH_TEMP';

    return buildResult(mode, supplyTemp, spaceTemp, outdoorTemp, setpoint, true, now);
  }

  // ── Normal Operation ──
  var fanEnable = true;

  if (error < -CONFIG.HEATING_DEADBAND) {
    // Too cold — heat
    mode = 'HEATING';
    var targetHW = clamp(Math.abs(error) * 10, 0, CONFIG.MAX_HW_POSITION);
    state.hwPosition = rampToward(state.hwPosition, targetHW, CONFIG.MAX_STEP);
    state.cwPosition = rampToward(state.cwPosition, 0, CONFIG.MAX_STEP);
    state.oaDamperPosition = rampToward(state.oaDamperPosition, CONFIG.MIN_OA_DAMPER, CONFIG.MAX_STEP);

  } else if (error > CONFIG.COOLING_DEADBAND) {
    // Too hot — cool
    var useEconomizer = outdoorTemp >= CONFIG.ECON_ENABLE_TEMP && outdoorTemp <= CONFIG.ECON_DISABLE_TEMP;

    if (useEconomizer) {
      mode = 'ECONOMIZER';
      var targetOA = clamp(error * 15, CONFIG.MIN_OA_DAMPER, 100);
      state.oaDamperPosition = rampToward(state.oaDamperPosition, targetOA, CONFIG.MAX_STEP);
      state.cwPosition = rampToward(state.cwPosition, 0, CONFIG.MAX_STEP);
    } else {
      mode = 'COOLING';
      var targetCW = clamp(error * 12, 0, CONFIG.MAX_CW_POSITION);
      state.cwPosition = rampToward(state.cwPosition, targetCW, CONFIG.MAX_STEP);
      state.oaDamperPosition = rampToward(state.oaDamperPosition, CONFIG.MIN_OA_DAMPER, CONFIG.MAX_STEP);
    }
    state.hwPosition = rampToward(state.hwPosition, 0, CONFIG.MAX_STEP);

  } else {
    // Within deadband — hold and decay
    mode = 'SATISFIED';
    state.hwPosition = rampToward(state.hwPosition, 0, CONFIG.MAX_STEP * 0.5);
    state.cwPosition = rampToward(state.cwPosition, 0, CONFIG.MAX_STEP * 0.5);
    state.oaDamperPosition = rampToward(state.oaDamperPosition, CONFIG.MIN_OA_DAMPER, CONFIG.MAX_STEP * 0.5);
  }

  return buildResult(mode, supplyTemp, spaceTemp, outdoorTemp, setpoint, fanEnable, now);
}

function buildResult(mode, supplyTemp, spaceTemp, outdoorTemp, setpoint, fanEnable, now) {
  // Clamp final positions
  var hw = clamp(state.hwPosition, 0, 100);
  var cw = clamp(state.cwPosition, 0, 100);
  var oa = clamp(state.oaDamperPosition, 0, 100);

  // Convert positions to voltages
  // HW valve: NO (Normally Open) — 0V = fully open, 10V = fully closed
  var hwVoltage = ((100 - hw) / 100) * 10;
  // CW valve: NO — same as HW
  var cwVoltage = ((100 - cw) / 100) * 10;
  // OA damper: Direct Acting — 0V = closed, 10V = fully open
  var oaVoltage = (oa / 100) * 10;

  // Log every 10 seconds
  if (now - state.lastLogTime > 10000) {
    console.log(
      '[CTRL] ' + mode +
      ' | SAT:' + supplyTemp.toFixed(1) +
      ' SP:' + setpoint.toFixed(1) +
      ' OAT:' + outdoorTemp.toFixed(1) +
      ' | HW:' + hw.toFixed(0) + '%(' + hwVoltage.toFixed(1) + 'V)' +
      ' CW:' + cw.toFixed(0) + '%(' + cwVoltage.toFixed(1) + 'V)' +
      ' OA:' + oa.toFixed(0) + '%(' + oaVoltage.toFixed(1) + 'V)' +
      ' | Fan:' + (fanEnable ? 'ON' : 'OFF')
    );
    state.lastLogTime = now;
  }

  return {
    outputs: {
      megabas0: {
        TR1: fanEnable,
        AO1: parseFloat(hwVoltage.toFixed(2)),
        AO2: parseFloat(cwVoltage.toFixed(2)),
        AO3: parseFloat(oaVoltage.toFixed(2)),
      }
    },
    status: {
      mode: mode,
      supplyTemp: supplyTemp,
      spaceTemp: spaceTemp,
      outdoorTemp: outdoorTemp,
      setpoint: setpoint,
      fanEnabled: fanEnable,
      hwPosition: parseFloat(hw.toFixed(1)),
      cwPosition: parseFloat(cw.toFixed(1)),
      oaDamperPosition: parseFloat(oa.toFixed(1)),
      timestamp: new Date().toISOString(),
    }
  };
}

// ── Exports ────────────────────────────────────────────────────────
module.exports = {
  execute: execute,
  CONFIG: CONFIG,
  getState: function() { return JSON.parse(JSON.stringify(state)); },
};
