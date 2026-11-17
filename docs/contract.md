# PV Monitor v3 contract

## Scope and transport

- Existing STM32F407, PC8/TIM3_CH3 servo, PC6 cleaner, PA15 buzzer,
  PB0/ADC8 shunt current, PB1/ADC9 potentiometer voltage, PB6/PB7 I2C1 SHT20,
  LCD/touch, and the user's external four-pin rain module: 3.3 V VCC, GND, DO -> PA4, AO unused.
  PA4 rain input is enabled. PA1 belongs to the five-way key op-amp output and is not touched.
  Active-low DO asserts rain at the next acquisition; high must persist for 500 ms to clear it.
  Internal pull-down treats floating/disconnected DO as rain protection, not proven dry.
  This cannot distinguish actual rain from a broken wire or prove module presence/power.
  Uninitialized or >1-second-old rain readings are invalid and block cleaning.
- Extension PIR: PB4/RDA226 active high; 60-second startup stabilization,
  5-second continuous-low clearing, SHT20 board-presence gate. LD1 is PC4, active
  high. PA5/ADC1_IN5 samples the four-pin NTC module's AO, not DO; configurable
  typical 10k/B3950 model gives an explicitly estimated 20..80 C panel reading.
- Primary USB bridge: the existing ST-Link virtual COM port and 10-pin ribbon,
  USART6 PG14 TX/PG9 RX (connector pins 8/5), 115200 8N1. No wiring changes.
  Source: FS-STM32F407-V2.0 core schematic, sheet 1, and tutorial PDF pages 223-224.
  SWD flashing and the virtual COM channel are separate functions of the same probe.
  On this computer the ST-Link VCP is COM6; CH340 COM5 is not this path.
  USART1 PA9/PA10 and USART3 PB10/PB11 remain alternative bridges.
  Only if using a matching FS-STM32db-v3.2 baseboard CH340, route S2/S3 to UART3;
  that optional baseboard path is not required for the photographed hardware.
- A computer running the gateway is required. No extra hardware is required.
  Standalone onboard ESP-12F Wi-Fi firmware is outside this release.
- Phone -> authenticated HTTP -> gateway -> serial -> device -> ACK -> SSE.
- Cloud: phone -> HTTPS cloud service -> MQTT/TLS -> gateway -> device.
  MQTT topics are pv/{deviceId}/{data,ack,presence,cmd}; commands are never retained.
  Device IDs use [A-Za-z0-9_-], 1..32 characters. Default: PV01.

## Serial framing and authority

Newline-delimited UTF-8 JSON, maximum 512 bytes per command.
Command: {"type":"cmd","cmdId":"32 lowercase hex characters","action":"angle","value":45}
ACK: {"type":"ack","cmdId":"...","accepted":true,"applied":true,"reason":"OK"}
Data: {"type":"data","protocol":3,"seq":1,"uptimeS":1,"current":123,
"panelTemp":23.4,"rain":null,"dustLevel":39,"tiltAngle":0,"targetAngle":0,
"cleaning":false,"mode":"manual","alarm":0,"quality":"estimated",
"baselineMa":200,"dustThreshold":40,"tempThreshold":65,"cleanSeconds":10,
"autoCooldownS":900,"adcCurrent":1536,"adcVoltage":789,"temperatureRaw":26212,
"validFlags":3,"temperatureStatus":"ok","saved":true,
"rainProtection":"unavailable","rainDryRemainingS":0,"motionPaused":false}

- Data is sent every second and promptly after a command. Values originate on the device.
- All three UARTs publish telemetry; ACKs return only on the UART receiving the command.
  USART6 uses PG9/PG14 AF8, not PC6/PC7, which belong to existing actuator outputs.
- ACK applied=true means the setpoint/output was applied, not measured shaft position.
- tiltAngle is the PWM-commanded angle, not an encoder measurement.
- validFlags: bit 0=current, bit 1=SHT20 temperature, bit 2=verified rain input.
  Invalid channels are JSON null, never a default temperature, zero, or stale last value.
  Dust is null unless quality=estimated. temperatureStatus=pending/ok/missing/crc/timeout.
  The gateway masks protocol=2 measurements as legacy, including history/CSV, and rejects
  starting clean/auto or baseline calibration on legacy firmware. Angle/stop remain available.
- SHT20: 7-bit address 0x40, command 0xF3 no-hold, 100ms nonblocking conversion wait,
  3-byte read, CRC8 polynomial 0x31 initialized to zero, status bits masked after CRC.
  T_C=-46.85+175.72*raw/65536. Range -40..125 C; wire data has one decimal place.
  panelTemp retains its legacy name but means measured SHT20 ambient temperature, not panel surface.
- Current: I_mA=ADC*33000/(4095*101), R54=0.1 ohm, R49/R50 gain=101.
  ADC rail saturation >=4080 is invalid. SHT20 failure gates the known expansion-board
  current channel invalid; this does not prove continuity of every individual analog wire.
  ADC values remain diagnostics, not guaranteed photovoltaic measurements.
- Dust is a relative current-loss estimate, NOT PM2.5 or measured dust thickness.
  Without an irradiance sensor, clouds/shading cannot be distinguished from dirt.
  No potentiometer-to-temperature conversion is permitted.
- quality is uncalibrated / estimated / low_current / invalid. Below 50 mA,
  relative dust is not displayed as a valid observation or used for automatic cleaning.
- Settings journals reserve sectors 10 and 11 (0x080C0000..0x080FFFFF).
  Record version=3 rejects old current-scale baselines; recalibration is required.
  The custom scatter file limits application code to the first 768 KiB.
- Gateway marks device offline after 5 seconds without valid telemetry.
- Commands older than 10 seconds, offline commands and retained commands are rejected.
- ACK retry: 3 transmissions, 1200 ms apart, same cmdId; firmware deduplicates retries.
  Only actual device ACKs can set applied=true. Timeouts are never success.

## Commands

| action | value / fields | behavior |
|---|---|---|
| angle | integer 0..90 | set target, move 1 degree every 20 ms |
| clean | integer 0/1 | off / bounded-duration cleaning; rain/temp interlocks |
| mode | integer 0/1 | manual / auto; auto requires a calibrated baseline |
| silence | integer 1 | silence current alarm for 60 seconds |
| stop | integer 1 | stop cleaner, return to manual, hold current servo angle |
| resume | integer 1 | explicitly release STOP latch with valid rain input; never start cleaning |
| pirAlarm | integer 0/1 | disable/enable only PIR alarm; keep detection, other alarms and actuator protections; runtime only, boot enabled |
| baseline | integer 1 | use current filtered reading; rejected below 50 mA |
| settings | dustThreshold 10..90, tempThreshold 35..90, cleanSeconds 3..30, autoCooldownS 60..3600 | validate all fields before applying |
| save | integer 1 | explicitly persist settings; rejected while cleaner runs |

Boot always stops the cleaner and starts in manual mode. Saved settings do not resume
motors. Servo starts at the confirmed stowed target of 0 degrees.
Auto requires current >= 50 mA, baseline >= 50 mA, a sustained 30-second dust threshold,
verified rain input, no rain, no overtemperature and an expired cooldown. It does not seek a solar maximum.
Unknown rain blocks cleaner startup, new angle commands and resume (RAIN_UNAVAILABLE).
All local touch/key and remote paths use the same safety checks.
Rain stops cleaning, disables auto and requests 90 degrees locally in either mode.
Only 10 seconds of continuous valid dry samples permits return to 0, without restarting
cleaning. Wet/unknown/stale data resets confirmation. STOP latches motionPaused and
holds PWM until explicit resume, including through wet/dry changes and reconnects.
During protective recovery, incompatible angle commands and cleaning/auto/baseline
startup are rejected. Moving the servo also prevents cleaning and baseline calibration.
Rain state is an optional atomic protocol-3 capability group (rainProtection,
rainDryRemainingS, motionPaused); older frames remain accepted but cannot enable resume.
See [rain-automation.md](rain-automation.md) for priority and compatibility details.
Overtemperature still stops cleaning locally even when disconnected.
ADC acquisition failure blocks cleaner startup. Watchdog resets stalled firmware.

Alarm bitmask: 1=dust estimate, 2=temperature threshold, 4=rain, 8=sensor fault,
16=PIR activity when pirAlarmEnabled. PIR is alarm-only, never an actuator lock.
Any active alarm, including rain, drives a 120 ms pulse each second unless muted.
The optional atomic protocol-3 extension group is personDetected (boolean/null),
pirStatus (warming/ok/unavailable), pirWarmupRemainingS (0..60, >0 only warming),
ld1Mode (alarm/cleaning/paused/idle), ntcAdc (0..4095/null), ntcStatus
(unconfigured/estimated/invalid), pirAlarmEnabled (boolean). New estimated/invalid
NTC firmware also requires surfaceTemp (20..80 C / null respectively); raw-only
unconfigured frames remain supported. Independent sample expiry is 2 s. Older firmware cannot accept pirAlarm.
Missing/warming PIR reports null, not no activity. Maintenance suppresses only bit
16, not activity telemetry. LD1 priority is alarm > cleaning > paused > idle.
See [pir-led.md](pir-led.md) for electrical evidence, UI behavior and limitations.
The NTC extension supersedes its original raw-only NTC behavior; see
[ntc-temperature.md](ntc-temperature.md). Existing SHT20 ambient protection and
panelTemp semantics remain unchanged. OneNET adds read-only personDetected and
surfaceTemp; only verified business receipts confirm their upload, not MQTT ACK.
Reasons: OK, INVALID_COMMAND, OUT_OF_RANGE, RAIN_INTERLOCK, TEMP_INTERLOCK,
SENSOR_FAULT, BASELINE_REQUIRED, LOW_CURRENT, BUSY, SAVE_FAILED, ID_CONFLICT,
DEVICE_OFFLINE, NO_ACK_TIMEOUT, STALE_COMMAND, CLOUD_OFFLINE, RATE_LIMITED.
RAIN_UNAVAILABLE, FIRMWARE_UPDATE_REQUIRED, MOTION_PAUSED, RAIN_RECOVERY.

## HTTP and storage

- POST /api/login {password}; HttpOnly/SameSite session cookie.
- POST /api/logout; GET /api/session.
- GET /api/access (authenticated, no-store): current reachable interface URLs from the actual bound listener.
  Wi-Fi is preferred; VMware/VirtualBox/Hyper-V, loopback and link-local addresses are excluded.
  Request Host is never used to construct QR targets. Configured public URL credentials/query/fragment are not encoded.
  Phone QR is rendered locally, contains only the URL and never grants a login session.
  The open dialog refreshes addresses every 15 seconds; downloaded QR images are static.
  QR does not bypass campus client isolation or establish a public tunnel.
- GET /api/state; GET /api/events (SSE snapshot/data/status/ack).
- Desktop and phone use one responsive control page. Named stow/shield presets
  send existing angle=0/90 commands, with the same local interlocks and audit.
  PWM angle/target/movement direction and rain countdown are telemetry-derived;
  ACK alone never updates the displayed setpoint or implies measured shaft travel.
  Offline values are marked last reported; disabled controls expose lock reasons.
  Cleaning mode is independent of always-active local rain safety.
- POST /api/command {action,value,...}; server creates cmdId and persists audit
  before sending; returns actual ACK or explicit timeout/offline rejection.
- GET /api/history?hours=1 (max 168); GET /api/export.csv?hours=24.
- GET /api/logs; GET /api/ports; POST /api/connection {port} (gateway only).
- GET /health exposes availability only, no measurements or credentials.
- SQLite stores real telemetry, control audits and their device ACKs.
- Gateway serial is the sole authority; cloud subscribes to that gateway's MQTT feed.
- No fabricated fallback measurements. Disconnected charts and values remain empty/stale.
- Simulator is explicitly opt-in and visibly marked SIMULATION, with separate storage.
- Cloud role requires a configured password and verified MQTT TLS. HTTPS is supplied
  by the included Caddy deployment. Broker credentials/ACLs are operator-provided.

## Acceptance

1. Existing servo regression and Keil build pass.
2. Firmware tests cover interlocks, timeout, malformed commands, retries and persistence CRC.
3. Backend tests cover authentication, offline/timeout/rejection, SSE, history and command audits.
4. Phone and desktop screenshots show no overflow, truthful connection state and usable controls.
5. An opt-in simulator exercises browser -> HTTP -> transport -> ACK -> telemetry without
   pretending it is physical hardware. Physical flashing and actual cloud credentials remain
   explicit integration steps, not claimed as completed remotely.
