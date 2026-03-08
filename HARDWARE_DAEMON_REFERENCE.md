# NexusEdge Hardware Daemon - Technical Reference

## What It Does

The hardware daemon is a Rust binary that runs on each Raspberry Pi controller. It is the sole owner of the I2C bus and provides all hardware reads/writes through an HTTP API on port 6100.

- Polls all enabled Sequent Microsystems boards every 1 second
- Caches all sensor readings in memory
- Exposes a REST API for reading cached values and writing outputs
- Reports raw hardware metrics to local Aegis-DB every 5 seconds
- Handles I2C bus retries and error recovery

## Supported Boards

| Board | I2C Base | Channels | Use Case |
|-------|----------|----------|----------|
| MegaBAS | 0x48 | 8 AI, 4 AO, 4 triacs, 8 dry contacts, 8x 1K/10K resistance | General HVAC I/O |
| MegaIND | 0x50 | 4 voltage in, 4 current in, 4 voltage out, 4 current out | Industrial I/O |
| UnivIn16 | 0x40 | 16 universal inputs (voltage, 1K, 10K) | Large input count |
| UOut16 | 0x60 | 16 analog outputs | Large output count |
| RelInd16 | 0x58 | 16 relays | Relay banks |
| RelInd8 | 0x38 | 8 relays | Relay banks |

Each board type supports stacking up to 8 units (address = base + stack, 0-7).

## Architecture

```
                    ┌─────────────────────────────────┐
                    │         main.rs                  │
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
- Poller thread (std): owns one I2C bus fd, reads all boards, updates shared cache
- Writer thread (std): owns separate I2C bus fd, processes write commands from crossbeam channel
- HTTP server (tokio): serves API requests, reads cache, sends write commands to writer queue
- Aegis-DB reporter (tokio task): reads cache every 5s, batch-inserts to local Aegis-DB

## MegaBAS I2C Register Map

Addresses from the Sequent Microsystems `megabas-rpi` sequential enum in `megabas.h`.

### Triacs & Dry Contacts (1-byte registers)

| Name | Register | Description |
|------|----------|-------------|
| TRIACS_VAL | 0x00 | Read/write all 4 triacs (bitmask, bits 0-3) |
| TRIACS_SET | 0x01 | Atomic set bits |
| TRIACS_CLR | 0x02 | Atomic clear bits |
| DRY_CONTACT | 0x03 | Read 8 dry contacts (bitmask, bits 0-7) |

### DAC Outputs (4 channels, 2 bytes each, little-endian u16, units = millivolts)

| Channel | Register | Voltage Range |
|---------|----------|---------------|
| AO1 | 0x04 | 0-10000 mV (0-10V) |
| AO2 | 0x06 | 0-10000 mV |
| AO3 | 0x08 | 0-10000 mV |
| AO4 | 0x0A | 0-10000 mV |

Formula: `register_value = voltage * 1000`

### ADC Inputs (8 channels, 2 bytes each, little-endian u16, units = millivolts)

| Channel | Register | Voltage Range |
|---------|----------|---------------|
| AI1 | 0x0C | 0-10000 mV (0-10V) |
| AI2 | 0x0E | |
| AI3 | 0x10 | |
| AI4 | 0x12 | |
| AI5 | 0x14 | |
| AI6 | 0x16 | |
| AI7 | 0x18 | |
| AI8 | 0x1A | |

Formula: `voltage = register_value / 1000.0`

### 1K Thermistor Inputs (8 channels, 2 bytes each, units = ohms)

| Channel | Register |
|---------|----------|
| 1K ch1 | 0x1C |
| 1K ch2 | 0x1E |
| ... | +2 each |
| 1K ch8 | 0x2A |

### 10K Thermistor Inputs (8 channels, 2 bytes each, units = ohms)

| Channel | Register |
|---------|----------|
| 10K ch1 | 0x2C |
| 10K ch2 | 0x2E |
| ... | +2 each |
| 10K ch8 | 0x3A |

### Diagnostics (after calibration/RTC/WDT sections in enum)

| Name | Register | Width | Units |
|------|----------|-------|-------|
| CPU_TEMP | 0x72 | 1 byte | Celsius |
| SUPPLY_24V | 0x73 | 2 bytes | millivolts |

### Addressing

Each MegaBAS board has base I2C address `0x48`. Stacking adds to the address:
- Stack 0: 0x48
- Stack 1: 0x49
- Stack 7: 0x4F

## NTC Thermistor Conversion

The daemon returns raw resistance in ohms for both 1K and 10K channels. Conversion to temperature happens in `boards.routes.js` on the controller using Steinhart-Hart:

```javascript
// 10K NTC Type 2 (Beta = 3950)
const T0 = 298.15;   // 25C in Kelvin
const R0 = 10000;    // 10K at 25C
const B = 3950;

const tempK = 1 / (1/T0 + (1/B) * Math.log(ohms / R0));
const tempF = (tempK - 273.15) * 9/5 + 32;
```

Typical resistance-to-temperature values (10K NTC):

| Resistance | Temperature |
|------------|-------------|
| 30K ohms | ~33F |
| 20K ohms | ~48F |
| 15K ohms | ~58F |
| 10K ohms | ~77F (25C) |
| 7K ohms | ~92F |
| 5K ohms | ~110F |

## HVAC Signal Conventions

### Heating Valve (Normally Open actuator)

The heating valve uses a **NO (Normally Open)** actuator. Power drives it closed.

| Voltage | Position | Heat |
|---------|----------|------|
| 0.00V | 100% OPEN | Maximum heat |
| 5.00V | 50% OPEN | Half heat |
| 10.00V | 0% (CLOSED) | No heat |

**This is inverted from what you might expect.** Lower voltage = more heat.

Conversion: `voltage = ((100 - heat_percent) / 100) * 10`

### Cooling Valve (Normally Closed actuator)

The cooling valve uses a **NC (Normally Closed)** actuator. Power drives it open.

| Voltage | Position | Cooling |
|---------|----------|---------|
| 0.00V | 0% (CLOSED) | No cooling |
| 5.00V | 50% OPEN | Half cooling |
| 10.00V | 100% OPEN | Maximum cooling |

Conversion: `voltage = (cool_percent / 100) * 10`

### Current Transformer (0-10V = 0-20A)

Fan/pump amps: `amps = voltage * 2`

### Dry Contacts (NC convention)

For safety devices (freeze stats, pressure switches): `1 = closed circuit = NORMAL`, `0 = open circuit = TRIPPED/FAULT`.

## API Quick Reference

All endpoints are on `http://127.0.0.1:6100` (localhost only).

### Read cached data

```bash
# Full cache (all boards, all channels)
curl -s http://localhost:6100/cache

# Health + board connectivity
curl -s http://localhost:6100/health

# Individual MegaBAS channels
curl -s http://localhost:6100/megabas/analog_inputs?stack=0
curl -s http://localhost:6100/megabas/analog_outputs?stack=0
curl -s http://localhost:6100/megabas/contacts?stack=0
curl -s http://localhost:6100/megabas/triacs?stack=0
curl -s http://localhost:6100/megabas/resistance_10k?stack=0
curl -s http://localhost:6100/megabas/resistance_1k?stack=0
```

### Write outputs

```bash
# Set single triac (channel 1-4)
curl -s -X POST http://localhost:6100/megabas/triac \
  -H "Content-Type: application/json" \
  -d '{"channel": 1, "state": true}'

# Set single analog output (channel 1-4, value 0-10V)
curl -s -X POST http://localhost:6100/megabas/analog_output \
  -H "Content-Type: application/json" \
  -d '{"channel": 2, "value": 5.0}'
```

### Comparing with CLI

The SM `megabas` CLI tool reads the same registers. Use it to verify daemon values:

```bash
megabas 0 adcrd 1       # AI1 voltage (should match analog_inputs[0])
megabas 0 r10krd 1      # 10K ch1 resistance in kOhms (daemon returns ohms)
megabas 0 dacrd 2       # AO2 voltage (should match analog_outputs[1])
megabas 0 trrd 1        # Triac 1 state
```

Note: CLI `r10krd` returns **kOhms** (e.g., 12.278), daemon returns **ohms** (e.g., 12278.0).

## Configuration

The daemon reads `hardware-daemon.toml` from its working directory (or `/etc/nexusedge/`).

```toml
[server]
host = "127.0.0.1"     # Bind address (localhost only for security)
port = 6100             # HTTP API port

[polling]
interval_ms = 1000      # How often to read all boards (minimum 100ms)

[i2c]
bus = 1                 # I2C bus number (/dev/i2c-1)
retry_count = 3         # Retries per failed read
retry_delay_ms = 10     # Delay between retries

[boards.megabas]
enabled = true
stacks = [0]            # Which stack addresses to poll

[boards.megaind]        # Disable unused board types
enabled = false
stacks = []

[aegisdb]
enabled = true
url = "http://localhost:9090"
interval_ms = 5000
equipment_id = "huntington-mua-3"
node_name = "huntington-mua3"
```

## Building and Deploying

### Prerequisites (production server)

- Rust toolchain: `/root/.cargo/bin/rustc`
- ARM cross-linker: `arm-linux-gnueabihf-gcc`
- Target installed: `armv7-unknown-linux-musleabihf`

### Build

```bash
cd /opt/NexusEdge/hardware_daemon
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release --target armv7-unknown-linux-musleabihf
```

### Deploy

```bash
# Copy to deploy staging
cp target/armv7-unknown-linux-musleabihf/release/nexusedge-hardware-daemon \
   /opt/NexusEdge/deploy/armhf/bin/

# Deploy to controller
scp /opt/NexusEdge/deploy/armhf/bin/nexusedge-hardware-daemon \
    Automata@<CONTROLLER_IP>:/home/Automata/NexusEdge/nexusedge-hardware-daemon

# On controller: restart
ssh Automata@<CONTROLLER_IP> "pm2 restart hardware-daemon && pm2 save --force"
```

### Verifying

```bash
# Check daemon is running
ssh Automata@<IP> "pm2 list | grep hardware"

# Check logs
ssh Automata@<IP> "pm2 log hardware-daemon --nostream --lines 10"

# Verify cache returns data
ssh Automata@<IP> "curl -s http://localhost:6100/cache | python3 -m json.tool"

# Compare daemon vs CLI
ssh Automata@<IP> "curl -s http://localhost:6100/megabas/analog_inputs | python3 -m json.tool && megabas 0 adcrd 1 && megabas 0 adcrd 2 && megabas 0 adcrd 3"
```

## Troubleshooting

### Daemon won't start (GLIBC error)

```
GLIBC_2.32 not found / GLIBC_2.33 not found / GLIBC_2.34 not found
```

The binary was compiled with `gnueabihf` target (dynamic linking). Rebuild with `musleabihf`:
```bash
cargo build --release --target armv7-unknown-linux-musleabihf
```

### I2C bus errors

Check that the Sequent Microsystems board is properly seated and the I2C bus is accessible:
```bash
i2cdetect -y 1     # Should show devices at 0x48+ range
```

### Cache returns empty

Check that the correct boards are enabled in `hardware-daemon.toml` and that the stack addresses match the physical DIP switch settings on the board.

### Values don't match CLI

The daemon and CLI should return identical values (they read the same I2C registers). If they differ, check:
1. Both are using the same I2C bus (`bus = 1` in config)
2. The daemon is actively polling (check `last_poll` in `/cache` response)
3. Values may fluctuate slightly between reads (normal for analog sensors)
