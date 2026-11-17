# NTC temperature and OneNET extension contract

## Measurement basis

Actual module: four pins VCC/GND/DO/AO. Photo showed AO disconnected while DO was
used. After changing AO -> PA5, the user measured ambient ADC 1940 and warmed ADC
1665. This supports a decreasing voltage response, not a calibrated temperature.
Power at 3.3 V, common GND. DO is not used for temperature. Disconnect power
before changing wires; never shift all three power/signal connections together.

The unverified starting model is fixed 10 kohm to supply, NTC to GND, R25=10 kohm,
B=3950 K. Constants are configurable in pv_sensors.h. With r=ADC/(4095-ADC),
Rntc=Rfixed*r, T_K=1/(1/298.15+ln(Rntc/R25)/B). Only the module's advertised
20..80 C range is published. Rail, failed, out-of-range or >2 s stale samples are
null, never zero or the last temperature. Floating analog wires cannot always be
detected in software. AO voltage, divider topology, actual NTC type, panel contact
and calibration remain physical checks. Every numeric NTC temperature is marked
estimated; do not claim reference-instrument accuracy or verified panel contact.
SHT20 remains independent ambient temperature and its existing protection stays
unchanged. This estimate does not replace it as a calibrated protection input.

## Firmware / server / UI

- Existing protocol 3 seven-key PIR group stays compatible. New surfaceTemp is
  present when ntcStatus is estimated/invalid; estimated requires a finite value
  20..80 C and raw ADC 1..4094, invalid requires null. Older unconfigured/raw-only
  firmware remains accepted and shows an update requirement, not Celsius.
- PA5 stays ADC1_IN5 with 480-cycle sampling and eight-sample averaging. Convert
  once per acquisition, no floating-point math in ISR. Independent 2 s expiry.
- LCD data page: ENV/SHT20 C separately from PANEL/NTC~ C (tilde=estimated).
  Desktop/phone explicitly label panel thermal readings as estimates, preserve
  raw ADC diagnostics and offline/last-report labels. Redraw only changed rows.
- No new command, flash record change, extra hardware or automatic flashing.

## OneNET

Keep current/panelTemp/rain/dustLevel/tiltAngle semantics. Add read-only properties:

| Identifier | Name | Type | Range | Step | Unit |
|---|---|---|---|---|---|
| personDetected | Human activity | bool | false=no activity, true=activity | n/a | none |
| surfaceTemp | Panel temperature (NTC estimate) | float | 20..80 | 0.1 | C |

These two definitions must be created and published in the user's OneNET product
console. Device credentials do not establish product-model edit authorization.
Firmware-provided PIR ok+boolean and NTC estimated+numeric values only; warming,
unavailable, invalid, unsupported, stale and simulated data are omitted. Existing
angle-only remote writes remain unchanged; new properties are read-only. Cloud
success still requires the matching OneNET code=200 receipt. Unknown-property
rejection is surfaced, not silently called success or masked as connectivity.
When an extended post is rejected, keep an extension-specific error, temporarily
post the original fields, and retry the new fields after 60 s. Base-field success
does not claim that the two new fields were accepted; confirmed field names are
shown in the device settings page.

## Acceptance

Actual codec/application tests: 25 C midpoint, 1940/1665 monotonic estimates, rails,
20/80 boundaries, stale/wraparound, SHT/NTC independence. MCU-generated JSON must
pass the Node validator and mapping. Local MQTT broker must confirm both new
properties and reject writes, missing/stale values and false receipts. Browser
tests cover desktop/mobile numeric estimates, invalid/legacy/offline display and
unchanged PIR maintenance. Warning-free Keil build. Do not flash, issue physical
commands, or publish synthetic values to production OneNET during verification.

2026-11-08 software evidence: three firmware host suites passed, including all
4094 non-rail ADC codes, 1940 -> 27.4 C and 1665 -> 33.6 C under the assumed
model; 36 Node tests and 9 Playwright tests passed. Browser screenshots cover
320/390/768/1440 px, NTC estimate vs SHT20 ambient, invalid/old/offline states.
Keil: 0 errors, 0 warnings; Code 23914, RO 3490, RW 212, ZI 17380 bytes.
The generic Arduino/Spring skill checker reported 0 errors and two non-applicable
warnings; actual STM32 serial JSON/MQTT contracts are covered by the tests above.
Physical thermal accuracy and OneNET product-model publication are not implied.
After an idle-only gateway reload, read-only live Edge checks found COM6 online,
simulation=false, old raw-only firmware (no surfaceTemp), and no browser errors
or /api/command requests. OneNET rejected the added property report; fallback
base-field posts still received code 200. Both new product definitions must be
published by the user and the new firmware must be flashed before final bench
and production two-property acceptance. No synthetic values were posted there.
