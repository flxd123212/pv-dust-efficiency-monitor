# Local rain automation contract

## Frozen behavior

- Confirmed mechanism: 0 degrees stowed, 90 degrees rain shield. Boot commands 0.
- A valid wet PA4 DO sample stops the cleaner, disables automatic cleaning, and
  requests 90 degrees in both manual and auto mode, without a phone/cloud link.
- Keep 90 while dry has not been continuously confirmed for 10 seconds. Wet or
  unavailable/stale input restarts this interval. Then return to 0; cleaning and
  auto mode remain off until explicitly enabled again.
- All commanded movement remains limited to 1 degree per 20 ms. There is no
  position feedback. Invalid rain input holds an ongoing protective movement;
  it never proves dry. Floating PA4 is pulled low and is treated as protective wet,
  which cannot distinguish water from an unplugged DO wire.
- STOP has priority: hold the current PWM angle, stop cleaning, disable auto,
  latch motionPaused. Samples, reconnects and retries cannot release this latch.
  Explicit resume=1 with valid rain input releases it, without enabling cleaning.
- While protection is wet/drying/returning, incompatible angle commands and
  cleaner/auto/baseline startup are rejected. While paused they are rejected with
  MOTION_PAUSED. Rain unknown rejects angle/startup/resume with RAIN_UNAVAILABLE.
- Rain alarms sound the existing bounded buzzer pulse; silence still lasts 60 s.
  Existing temperature and estimated-dust rules remain, with no invented sensors.

## Additive protocol 3 fields

- rainProtection: idle / rain / drying / returning / unavailable.
- rainDryRemainingS: integer 0..10, ceil of remaining confirmed dry time;
  zero outside drying. motionPaused: boolean STOP latch.
- These three fields form one optional capability group. Older protocol 3 frames
  without the group remain valid; the UI shows unavailable automation capability
  and does not enable resume. No gateway-generated protective status.
- resume command: {action:"resume",value:1}; normal cmdId/ACK/dedup contract.
- New rejection reasons: MOTION_PAUSED, RAIN_RECOVERY. Existing RAIN_INTERLOCK,
  RAIN_UNAVAILABLE and FIRMWARE_UPDATE_REQUIRED remain in use.
- Fields and pause/rain state are RAM only. Flash settings/version unchanged.
  OneNET still uploads only current, panelTemp, rain, dustLevel, tiltAngle;
  tiltAngle remains the actual PWM command, never a requested target substitution.

## Desktop and phone control surface

- One responsive control surface for both clients. Keep current/temperature/rain/
  dust observations, cleaning mode, thresholds, bounded cleaning, alarm mute and
  command audit. Cleaning mode does not switch off local rain safety.
- Add direct stow (angle=0) and shield (angle=90) commands using the existing
  authenticated command/ACK path. No new firmware action, settings or hardware.
- Show PWM-commanded angle, target angle, increasing/decreasing/holding/paused
  state, rain recovery countdown from telemetry, and explicit control lock reasons.
  Never claim encoder feedback, interpolate an unreported angle, or count down
  recovery on the browser's clock. Distinguish live data from last reported data.
- Stow is disabled while wet/drying/returning/paused/unknown. Shield may be
  requested while wet/drying, but not returning/paused/unknown. Existing manual
  angle fallback remains for older firmware; protected shortcuts and resume stay
  unavailable until the rain-automation capability is present.
- Offline or pending commands disable starts/presets/resume. STOP stays available
  when live, even while another command is pending. Rejection/timeout/offline is
  never successful motion; both clients reflect subsequent authoritative telemetry.
- Verify dry presets, rain/returning locks, STOP/resume, null/legacy data,
  delayed ACK without telemetry, rejected requests, and network loss at desktop,
  tablet and 320/390 px phone widths with no text/control overlap.

## Acceptance Evidence

Test wet/manual/auto shutdown, ramp, continuous dry boundary, rewet, missing and
stale data, timer wraparound, STOP/retry/resume priorities, strict protocol parsing,
older firmware UI, mobile layouts, and a warning-free Keil build. Use isolated
simulation for browser tests. Do not send test actuator commands to connected hardware.
Physical travel, obstruction and wet/dry module threshold require supervised bench
validation after flashing, with the mechanism clear and STOP accessible.
