# PIR approach alarm and expansion LD1

NTC update: [ntc-temperature.md](ntc-temperature.md) supersedes the original
raw-only PA5 notes below. Four-pin AO is now converted with an explicitly
estimated configurable typical model. OneNET adds personDetected/surfaceTemp.

## Frozen contract

- Scope: local approach alarm, not a cleaner/servo interlock. A PIR event must
  not stop/start cleaning, change mode or move the servo. Rain, temperature,
  STOP/resume and timed-cleaning protections remain unchanged.
- Schematic basis (high confidence for the documented board revisions): extension
  FS_MP1A_Extend_v3.3 sheet 2 U10 RDA226 REL -> RELOUT -> J1 pin 16;
  FS-STM32db-v3.2 J6 pin 16 IO_PIR -> PB4. REL high means motion (RDA226 v1.3
  datasheet p4/p8). It detects moving heat sources, not distance or guaranteed
  stationary occupancy. No triggering is not proof of an empty area.
- PB4 is input with pull-up. SHT20 availability gates the known extension board,
  not individual PIR-wire continuity. A disconnected PB4 with the board otherwise
  present tends to assert motion, not proven absence. No claim of exhaustive fault
  detection or certified personnel protection.
- Wait 60 s after board availability/reconnection (datasheet p11 stabilization),
  then report activity high immediately; clear after 5 s of continuously low
  samples, in addition to the sensor's own hold time. Missing board, >1 s polling
  gap, or stale application samples makes PIR unavailable, never false/no-person.
- LD1: extension LED1 -> NPN Q1 -> high = on; baseboard LED1 -> PC4. Alarm:
  250 ms on/250 ms off. Otherwise cleaning = on, STOP latch = 100 ms per second,
  idle = off. This reports commanded LED mode, not optical feedback.
- PIR adds alarm bit 16. Existing alarm bits stay unchanged. The existing buzzer
  emits its 120 ms per-second pulse for any alarm, including PIR. silence=1 mutes
  sound for 60 s, without suppressing telemetry or LD1. Clearing PIR never clears
  concurrent rain/temperature/dust/fault alarms.
- Maintenance switch: pirAlarm=0/1 disables/enables only the PIR contribution to
  alarm bit 16, buzzer and LD1. Detection/telemetry continue while disabled; rain,
  temperature, dust and faults remain audible/visible. Runtime only: boot enables
  PIR alarms, no Flash writes or automatic actuator changes.

## Data and UI

- Additive protocol 3 capability group (all seven keys or none): personDetected
  (boolean when pirStatus=ok, otherwise null), pirStatus (warming/ok/unavailable),
  pirWarmupRemainingS (integer 0..60, zero unless warming), ld1Mode
  (alarm/cleaning/paused/idle), ntcAdc (integer 0..4095 or null), ntcStatus
  (unconfigured), pirAlarmEnabled (boolean). Older frames show unsupported PIR
  rather than invented absence and cannot enable the maintenance switch.
- Desktop/phone show activity, warmup countdown from device, LD1 command mode,
  last-reported/offline state and the normal alarm/mute controls. No client alarm
  timer or new command bypass. OneNET model remains its existing five properties.
- Desktop/phone provide a binary PIR alarm switch. Send {action:"pirAlarm",value:0}
  or value:1 through existing authentication, audit, serial cmdId and actual ACK.
  The switch reflects firmware telemetry, never the input event or ACK alone.
  Offline/pending/unsupported states disable it. A stale frame is not confirmation.
- LCD shows PIR state on every page. Its STOP tile becomes RESUME while paused;
  tapping the same tile calls the existing resume command. A rejected resume
  displays its real reason. Physical long-press remains unconditional STOP.
- PA5/ADC1_IN5 is reserved for the external thermistor AO; 480-cycle sampling.
  It is free in the current firmware and the documented baseboard exposes PA5.
  Only raw diagnostics are published, clearly unconfigured. Do not convert to
  temperature until thermistor/module type, divider orientation, resistance/Beta
  and 3.3 V compatibility are confirmed. A bare two-lead NTC needs a divider;
  DO alone cannot measure temperature. Existing panelTemp remains documented
  SHT20 ambient temperature, not NTC panel temperature. Never connect 5 V AO.

## Verification

Run actual driver mocks (pin/pull, warmup, assert, delayed clear, missing board,
stale/gap/reconnect/wraparound), application tests (PIR alarm without actuator
side effects, combined alarms, mute/LD1, STOP/resume), serial JSON contract,
backend validation, desktop/mobile browser checks and warning-free Keil build.
Bench travel/temperature calibration/PIR range are not software-test evidence.
Do not flash or send production actuator commands during automated verification.

2026-11-08 software evidence: all three firmware host suites pass; 33 Node tests
pass including actual MCU-generated PIR frames and maintenance ACKs; 8 Playwright
tests pass with maintenance/activity/other-alarm separation, ACK-only non-update,
unsupported/offline states and 320/390/768/1440 px extension screenshots. Keil
build: 0 errors, 0 warnings; Code 23006, RO 3406, RW 212, ZI 17364 bytes.
No production control commands or flashing are part of this verification.
The generic skill checker reported no errors and two non-applicable warnings
(this is STM32 C + Node serial JSON, not Arduino MQTT macros + Spring YAML).
The relevant contract is covered by actual C-generated serial JSON/ACK tests.
The idle local gateway was reloaded, then checked read-only in desktop/mobile
Edge: COM6 online, simulation=false, OneNET connected with last post code 200,
zero /api/command requests. The attached board still lacks the new capability;
the UI correctly displays firmware-update-required and disables the switch.
