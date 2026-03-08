<p align="center">
  <img src="docs/talos-logo.png" alt="Talos Hardware Daemon" width="200"/>
  <br/>
  <strong>Talos Hardware Daemon</strong>
</p>

<p align="center">
  <a href="https://github.com/AutomataControls/Talos/releases"><img src="https://img.shields.io/github/v/release/AutomataControls/Talos?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/AutomataControls/Talos/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Proprietary-red?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-Raspberry%20Pi-C51A4A?style=flat-square&logo=raspberrypi&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/lang-Rust-orange?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/I2C-Sequent%20Microsystems-green?style=flat-square" alt="I2C">
  <img src="https://img.shields.io/badge/arch-ARMv7%20%7C%20AArch64-lightgrey?style=flat-square" alt="Architecture">
</p>

---

**Talos** is a Rust-based hardware daemon for reliable, low-latency I2C communication with [Sequent Microsystems](https://sequentmicrosystems.com/) HATs on Raspberry Pi. It is the sole owner of the I2C bus — all hardware reads and writes flow through its HTTP API on port `6100`.

Part of the [NexusEdge](https://github.com/AutomataControls) industrial control platform by **AutomataNexus**.

## Features

- Polls all enabled Sequent Microsystems boards every 1 second
- Caches all sensor readings in memory (sub-millisecond API response)
- REST API for reading cached values and writing outputs
- Reports raw hardware metrics to local Aegis-DB every 5 seconds
- I2C bus retry and error recovery
- GPIO pin support for direct-relay boards (e.g. Waveshare)
- Static musl binaries — no GLIBC dependency, runs on any ARM Linux

## Supported Boards

| Board | I2C Base | Channels | Use Case |
|-------|----------|----------|----------|
| **MegaBAS** | `0x48` | 8 AI, 4 AO, 4 triacs, 8 dry contacts, 8× 1K/10K resistance | General HVAC I/O |
| **MegaIND** | `0x50` | 4 voltage in, 4 current in, 4 voltage out, 4 current out | Industrial I/O |
| **UnivIn16** | `0x40` | 16 universal inputs (voltage, 1K, 10K) | Large input count |
| **UOut16** | `0x60` | 16 analog outputs (0–10V) | Large output count |
| **RelInd16** | `0x58` | 16 relays | Relay banks |
| **RelInd8** | `0x38` | 8 relays | Relay banks |

Each board type supports stacking up to **8 units** (address = base + stack, 0–7).

## Architecture

```
                ┌─────────────────────────────────┐
                │           main.rs                │
                │  Loads config, spawns threads,   │
                │  starts HTTP server              │
                └────┬──────┬──────┬──────┬───────┘
                     │      │      │      │
        ┌────────────▼┐ ┌──▼────┐ ┌▼─────▼──────┐
        │ poller.rs    │ │writer │ │ server.rs    │
        │ (std thread) │ │.rs    │ │ (tokio)      │
        │ Reads I2C    │ │Writes │ │ Axum HTTP    │
        │ every 1s     │ │I2C    │ │ on :6100     │
        │ Updates cache│ │from Q │ │              │
        └──────┬───────┘ └───┬───┘ └──────┬──────┘
               │             │             │
        ┌──────▼─────────────▼─────────────▼──────┐
        │              cache.rs                     │
        │  SharedCache (parking_lot::RwLock)        │
        │  HashMap<stack, BoardData> per board type │
        └──────────────────────────────────────────┘
               │
        ┌──────▼──────┐
        │ aegisdb.rs   │
        │ (tokio task) │
        │ Reports to   │
        │ local :9090  │
        └─────────────┘
```

**Thread model:**
- **Poller** (std thread) — owns one I2C bus fd, reads all boards, updates shared cache
- **Writer** (std thread) — owns separate I2C bus fd, processes write commands from crossbeam channel
- **HTTP server** (tokio) — serves API requests, reads cache, sends write commands to writer queue
- **Aegis-DB reporter** (tokio task) — reads cache every 5s, batch-inserts to local Aegis-DB

## Installation

### From Release Binary

Download the latest binary from [Releases](https://github.com/AutomataControls/Talos/releases):

```bash
# Raspberry Pi 3/4 (32-bit) — ARMv7
wget https://github.com/AutomataControls/Talos/releases/latest/download/talos-hwdaemon-armv7
chmod +x talos-hwdaemon-armv7
sudo mv talos-hwdaemon-armv7 /usr/local/bin/talos-hwdaemon

# Raspberry Pi 4/5 (64-bit) — AArch64
wget https://github.com/AutomataControls/Talos/releases/latest/download/talos-hwdaemon-aarch64
chmod +x talos-hwdaemon-aarch64
sudo mv talos-hwdaemon-aarch64 /usr/local/bin/talos-hwdaemon
```

### Configuration

Copy the example config to `/etc/nexusedge/` or the daemon's working directory:

```bash
sudo mkdir -p /etc/nexusedge
sudo cp hardware-daemon.toml /etc/nexusedge/hardware-daemon.toml
```

Edit the config to enable your boards and set stack addresses:

```toml
[server]
host = "127.0.0.1"
port = 6100

[polling]
interval_ms = 1000

[i2c]
bus = 1
retry_count = 3
retry_delay_ms = 10

[boards.megabas]
enabled = true
stacks = [0]

[boards.megaind]
enabled = false
stacks = []
```

### Run with PM2

```bash
pm2 start talos-hwdaemon --name talos-daemon
pm2 save --force
```

## API Quick Reference

All endpoints serve on `http://127.0.0.1:6100` (localhost only).

### Read Cached Data

```bash
# Full cache (all boards, all channels)
curl -s http://localhost:6100/cache

# Health + board connectivity
curl -s http://localhost:6100/health

# MegaBAS channels
curl -s http://localhost:6100/megabas/analog_inputs?stack=0
curl -s http://localhost:6100/megabas/resistance_10k?stack=0
curl -s http://localhost:6100/megabas/contacts?stack=0
curl -s http://localhost:6100/megabas/triacs?stack=0
```

### Write Outputs

```bash
# Set triac (channel 1-4)
curl -s -X POST http://localhost:6100/megabas/triac \
  -H "Content-Type: application/json" \
  -d '{"channel": 1, "state": true}'

# Set analog output (channel 1-4, 0-10V)
curl -s -X POST http://localhost:6100/megabas/analog_output \
  -H "Content-Type: application/json" \
  -d '{"channel": 2, "value": 5.0}'
```

## HVAC Signal Conventions

### Heating Valve (Normally Open)

| Voltage | Position | Heat |
|---------|----------|------|
| 0.00V | 100% OPEN | Maximum heat |
| 5.00V | 50% OPEN | Half heat |
| 10.00V | 0% (CLOSED) | No heat |

**Inverted:** Lower voltage = more heat. Formula: `voltage = ((100 - heat%) / 100) × 10`

### Cooling Valve (Normally Closed)

| Voltage | Position | Cooling |
|---------|----------|---------|
| 0.00V | 0% (CLOSED) | No cooling |
| 5.00V | 50% OPEN | Half cooling |
| 10.00V | 100% OPEN | Maximum cooling |

Formula: `voltage = (cool% / 100) × 10`

### NTC Thermistor Conversion

The daemon returns raw resistance (ohms). Convert to temperature using Steinhart-Hart:

```javascript
// 10K NTC Type 2 (Beta = 3950)
const T0 = 298.15, R0 = 10000, B = 3950;
const tempK = 1 / (1/T0 + (1/B) * Math.log(ohms / R0));
const tempF = (tempK - 273.15) * 9/5 + 32;
```

| Resistance | Temperature |
|------------|-------------|
| 30K Ω | ~33°F |
| 10K Ω | ~77°F (25°C) |
| 5K Ω | ~110°F |

## Examples

See the [`examples/`](examples/) directory for a complete working integration:

- **`coordinator.js`** — Manages executor lifecycle, health monitoring, graceful shutdown
- **`executor.js`** — Reads sensors from Talos API, runs control logic, writes outputs
- **`logic/equipment/temperature_control.js`** — Pure control logic for AHU heating/cooling with rate-limited valve ramping

## Troubleshooting

### GLIBC Errors

If you see `GLIBC_2.32 not found`, the binary was built with the wrong target. The release binaries use `musleabihf`/`musl` (static linking) and have no GLIBC dependency.

### I2C Bus Errors

```bash
i2cdetect -y 1    # Should show devices at 0x48+ range
```

### Cache Returns Empty

Verify board DIP switch settings match `stacks = [...]` in your config.

### CLI vs Daemon Values

The SM `megabas` CLI reads the same registers. Note: CLI `r10krd` returns **kΩ**, daemon returns **Ω**.

```bash
megabas 0 adcrd 1     # Compare with /megabas/analog_inputs
megabas 0 r10krd 1    # kΩ → multiply by 1000 for daemon Ω
```

---

<p align="center">
  <img src="docs/favicon.png" alt="AutomataNexus" width="32"/>
  <br/>
  <sub>Built by <strong>AutomataNexus, LLC</strong></sub>
  <br/>
  <sub>© 2026 AutomataNexus. All rights reserved.</sub>
</p>
