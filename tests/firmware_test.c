#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "pv_app.h"
#include "pv_store.h"

static unsigned int saves;
int PV_StoreWrite(const PV_Settings *settings) { assert(PV_SettingsValid(settings)); saves++; return 1; }
static const char *id = "0123456789abcdef0123456789abcdef";
static char ack[192], command[512], data[PV_TELEMETRY_CAPACITY];
static void sample(uint32_t now) { PV_Sample(3000u, 0x6664u, 0u, 7u, now); }
static void request(const char *action, unsigned int value, uint32_t now)
{
  snprintf(command, sizeof(command), "{\"type\":\"cmd\",\"cmdId\":\"%s\",\"action\":\"%s\",\"value\":%u}", id, action, value);
  assert(PV_Command(command, ack, sizeof(ack), now));
}

static void rain_sample(uint8_t wet, uint8_t flags, uint32_t now)
{
  PV_Sample(3000u, 0x6664u, wet, flags, now);
  PV_Tick(now);
}

static void rain_tests(void)
{
  uint32_t t, stopped, start;
  PV_Settings cfg = {300u, 40u, 65u, 10u, 60u};
  PV_Init(0u, &cfg); sample(0u);
  assert(!strcmp(PV_Apply("mode", 1u, 0u), "OK"));
  assert(!strcmp(PV_Apply("clean", 1u, 0u), "OK"));
  rain_sample(1u, 7u, 100u);
  assert(!pv.cleaning && !pv.automatic && pv.target == 90u && pv.rain_state == PV_RAIN_WET);
  assert(PV_AlarmAudible(100u));
  assert(!strcmp(PV_Apply("silence", 1u, 100u), "OK") && !PV_AlarmAudible(100u));
  assert(!strcmp(PV_Apply("angle", 0u, 100u), "RAIN_INTERLOCK"));
  assert(!strcmp(PV_Apply("mode", 1u, 100u), "RAIN_INTERLOCK"));
  for (t = 120u; t <= 1900u; t += 20u) rain_sample(1u, 7u, t);
  assert(pv.angle == 90u);
  rain_sample(0u, 7u, 2000u);
  assert(pv.rain_state == PV_RAIN_DRYING && PV_RainDryRemaining(2000u) == 10u);
  assert(!strcmp(PV_Apply("clean", 1u, 2000u), "RAIN_RECOVERY"));
  assert(!strcmp(PV_Apply("angle", 0u, 2000u), "RAIN_RECOVERY"));
  for (t = 2020u; t < 12000u; t += 20u) rain_sample(0u, 7u, t);
  assert(pv.target == 90u && PV_RainDryRemaining(11999u) == 1u);
  rain_sample(0u, 7u, 12000u);
  assert(pv.target == 0u && pv.rain_state == PV_RAIN_RETURNING && !pv.cleaning && !pv.automatic);
  for (t = 12020u; t <= 13800u; t += 20u) rain_sample(0u, 7u, t);
  assert(pv.angle == 0u && pv.rain_state == PV_RAIN_IDLE);

  /* STOP survives repeated wet samples and cached command retries. */
  rain_sample(1u, 7u, 14000u);
  assert(!strcmp(PV_Apply("stop", 1u, 14000u), "OK"));
  stopped = pv.angle;
  for (t = 14020u; t <= 15000u; t += 20u) rain_sample(1u, 7u, t);
  assert(pv.motion_paused && pv.angle == stopped && pv.target == stopped);
  assert(!strcmp(PV_Apply("angle", 90u, 15000u), "MOTION_PAUSED"));
  assert(!strcmp(PV_Apply("clean", 1u, 15000u), "MOTION_PAUSED"));
  request("resume", 1u, 15000u);
  assert(strstr(ack, "\"applied\":true") && !pv.motion_paused && pv.target == 90u);
  assert(!strcmp(PV_Apply("stop", 1u, 15000u), "OK"));
  assert(PV_Command(command, ack, sizeof(ack), 15001u) && pv.motion_paused);
  for (t = 15020u; t <= 26000u; t += 20u) rain_sample(0u, 7u, t);
  assert(pv.motion_paused && pv.angle == stopped && pv.target == stopped && !pv.cleaning);
  rain_sample(0u, 3u, 26001u);
  assert(!strcmp(PV_Apply("resume", 1u, 26001u), "RAIN_UNAVAILABLE"));
  assert(PV_Telemetry(data, sizeof(data), 26001u) && strstr(data, "\"motionPaused\":true") && strstr(data, "\"rainProtection\":\"unavailable\""));
  rain_sample(0u, 7u, 26020u);
  assert(!strcmp(PV_Apply("resume", 1u, 26020u), "OK"));
  assert(pv.target == 90u && !pv.cleaning && !pv.automatic);

  /* Interrupted dry confirmation must restart, including an acquisition gap. */
  for (t = 26040u; t <= 35000u; t += 20u) rain_sample(0u, 7u, t);
  rain_sample(1u, 7u, 35020u); rain_sample(0u, 7u, 35040u);
  assert(PV_RainDryRemaining(35040u) == 10u);
  rain_sample(0u, 3u, 35060u);
  stopped = pv.angle;
  PV_Tick(35080u);
  assert(pv.angle == stopped && pv.target == stopped);
  rain_sample(0u, 7u, 35080u);
  assert(PV_RainDryRemaining(35080u) == 10u);
  rain_sample(0u, 7u, 50000u);
  assert(pv.rain_state == PV_RAIN_DRYING && PV_RainDryRemaining(50000u) == 10u && pv.target == 90u);
  PV_Tick(52001u);
  assert(!pv.valid_flags && pv.target == pv.angle && !strcmp(PV_RainStatus(), "unavailable"));
  assert(!strcmp(PV_Apply("angle", 0u, 52001u), "RAIN_UNAVAILABLE"));

  start = UINT32_MAX - 5000u;
  PV_Init(start, 0); rain_sample(1u, 7u, start); rain_sample(0u, 7u, start + 20u);
  for (t = 40u; t <= 10000u; t += 20u) rain_sample(0u, 7u, start + t);
  assert(pv.rain_state == PV_RAIN_DRYING && pv.target == 90u);
  rain_sample(0u, 7u, start + 10020u);
  assert(pv.rain_state == PV_RAIN_RETURNING && pv.target == 0u);
  assert(PV_Telemetry(data, sizeof(data), start + 10020u));
  PV_Init(0u, &cfg);
  assert(!pv.motion_paused && !pv.cleaning && !pv.automatic && pv.target == 0u);
}

static void pir_tests(void)
{
  unsigned int saved_before = saves;
  PV_Settings cfg = {300u, 40u, 65u, 10u, 60u};
  PV_Init(0u, &cfg); sample(0u);
  PV_PirSample(PV_PIR_WARMING, 1u, 60u, 0u); PV_Tick(0u);
  assert(!(pv.alarm & 16u) && !pv.person_detected && !strcmp(PV_LedMode(), "idle"));
  assert(PV_Telemetry(data, sizeof(data), 0u) && strstr(data, "\"personDetected\":null") && strstr(data, "\"pirStatus\":\"warming\""));
  assert(!strcmp(PV_Apply("mode", 1u, 0u), "OK"));
  assert(!strcmp(PV_Apply("clean", 1u, 0u), "OK"));
  PV_PirSample(PV_PIR_OK, 1u, 0u, 100u); PV_Tick(100u);
  assert((pv.alarm & 16u) && pv.cleaning && pv.automatic && pv.target == 0u);
  assert(PV_AlarmAudible(100u) && PV_LedOn(100u) && !PV_LedOn(300u));
  assert(!strcmp(PV_LedMode(), "alarm"));
  assert(!strcmp(PV_Apply("silence", 1u, 100u), "OK"));
  assert(!PV_AlarmAudible(100u) && PV_LedOn(100u) && (pv.alarm & 16u));
  assert(PV_Telemetry(data, sizeof(data), 100u) && strstr(data, "\"personDetected\":true"));
  assert(!strcmp(PV_Apply("pirAlarm", 0u, 100u), "OK"));
  assert(!pv.pir_alarm_enabled && !(pv.alarm & 16u) && pv.person_detected);
  assert(pv.cleaning && pv.automatic && pv.target == 0u && pv.saved);
  assert(!PV_AlarmAudible(100u) && !strcmp(PV_LedMode(), "cleaning"));
  PV_Tick(100u);
  assert(!(pv.alarm & 16u) && saves == saved_before);
  assert(PV_Telemetry(data, sizeof(data), 100u) && strstr(data, "\"pirAlarmEnabled\":false") && strstr(data, "\"personDetected\":true"));
  assert(!strcmp(PV_Apply("pirAlarm", 2u, 100u), "OUT_OF_RANGE") && !pv.pir_alarm_enabled);
  assert(!strcmp(PV_Apply("pirAlarm", 1u, 100u), "OK") && (pv.alarm & 16u));
  assert(!strcmp(PV_Apply("clean", 0u, 100u), "OK"));
  assert(!strcmp(PV_Apply("clean", 1u, 100u), "OK"));
  PV_PirSample(PV_PIR_OK, 0u, 0u, 200u); PV_Tick(200u);
  assert(!(pv.alarm & 16u) && pv.cleaning && pv.automatic && !strcmp(PV_LedMode(), "cleaning") && PV_LedOn(300u));
  PV_Sample(3000u, 0x6664u, 1u, 7u, 300u);
  PV_PirSample(PV_PIR_OK, 1u, 0u, 300u); PV_Tick(300u);
  assert((pv.alarm & 20u) == 20u && !pv.cleaning && pv.target == 90u);
  assert(!strcmp(PV_Apply("pirAlarm", 0u, 300u), "OK"));
  assert((pv.alarm & 4u) && !(pv.alarm & 16u) && pv.person_detected);
  assert(!strcmp(PV_LedMode(), "alarm"));
  assert(!strcmp(PV_Apply("pirAlarm", 1u, 300u), "OK") && (pv.alarm & 16u));
  PV_PirSample(PV_PIR_OK, 0u, 0u, 400u); PV_Tick(400u);
  assert((pv.alarm & 4u) && !(pv.alarm & 16u));
  PV_PirSample(PV_PIR_OK, 1u, 0u, 400u); PV_Tick(400u);
  sample(2401u); PV_Tick(2401u);
  assert(pv.pir_status == PV_PIR_UNAVAILABLE && !(pv.alarm & 16u));
  assert(PV_Telemetry(data, sizeof(data), 2401u) && strstr(data, "\"personDetected\":null") && strstr(data, "\"ntcStatus\":\"invalid\""));

  PV_Init(0u, 0); sample(0u); PV_Tick(0u);
  assert(pv.pir_alarm_enabled && saves == saved_before);
  request("pirAlarm", 0u, 0u);
  assert(strstr(ack, "\"applied\":true") && !pv.pir_alarm_enabled);
  assert(!strcmp(PV_Apply("pirAlarm", 1u, 0u), "OK"));
  assert(PV_Command(command, ack, sizeof(ack), 0u) && pv.pir_alarm_enabled);
  PV_Sample(3000u, 0xC000u, 0u, 7u, 0u);
  PV_PirSample(PV_PIR_OK, 1u, 0u, 0u); PV_Tick(0u);
  assert((pv.alarm & 18u) == 18u);
  assert(!strcmp(PV_Apply("pirAlarm", 0u, 0u), "OK"));
  assert((pv.alarm & 2u) && !(pv.alarm & 16u) && PV_AlarmAudible(0u));
  PV_Init(0u, 0); sample(0u); PV_Tick(0u);
  assert(!strcmp(PV_LocalStopAction(), "stop"));
  assert(!strcmp(PV_Apply(PV_LocalStopAction(), 1u, 0u), "OK"));
  assert(pv.motion_paused && !strcmp(PV_LocalStopAction(), "resume"));
  assert(!strcmp(PV_LedMode(), "paused") && PV_LedOn(50u) && !PV_LedOn(150u));
  assert(!strcmp(PV_Apply(PV_LocalStopAction(), 1u, 1u), "OK") && !pv.motion_paused);
  assert(!strcmp(PV_LedMode(), "idle") && !PV_LedOn(1u));
  assert(!strcmp(PV_Apply("stop", 1u, 1u), "OK"));
  PV_Sample(3000u, 0x6664u, 0u, 3u, 2u);
  assert(!strcmp(PV_Apply(PV_LocalStopAction(), 1u, 2u), "RAIN_UNAVAILABLE") && pv.motion_paused);
  PV_Init(UINT32_MAX - 100u, 0); sample(UINT32_MAX - 100u);
  PV_PirSample(PV_PIR_OK, 1u, 0u, UINT32_MAX - 100u); PV_Tick(100u);
  assert(pv.alarm & 16u);
  sample(2000u); PV_Tick(2000u);
  assert(pv.pir_status == PV_PIR_UNAVAILABLE && !(pv.alarm & 16u));
  puts("PIR application tests passed (alarm only, maintenance enable/disable without hiding detection or other alarms, reboot default, no Flash writes, ACK/dedup, mute/LD1, stale/wraparound, LCD STOP/resume).");
}
static void ntc_tests(void)
{
  int16_t ambient, warmed, temperature;
  uint32_t adc, accepted = 0u;
  assert(PV_NtcTemperatureDeci(2048u, &temperature) && temperature == 250);
  assert(PV_NtcTemperatureDeci(1940u, &ambient));
  assert(PV_NtcTemperatureDeci(1665u, &warmed) && warmed > ambient);
  assert(ambient >= 273 && ambient <= 275 && warmed >= 334 && warmed <= 338);
  assert(!PV_NtcTemperatureDeci(0u, &temperature));
  assert(!PV_NtcTemperatureDeci(4095u, &temperature));
  assert(!PV_NtcTemperatureDeci(0xFFFFu, &temperature));
  assert(!PV_NtcTemperatureDeci(129u, &temperature));
  assert(!PV_NtcTemperatureDeci(1940u, 0));
  for (adc = 1u; adc < 4095u; adc++)
    if (PV_NtcTemperatureDeci((uint16_t)adc, &temperature))
    {
      assert(temperature >= 200 && temperature <= 800);
      accepted++;
    }
  assert(accepted > 1500u);
  PV_Init(0u, 0); sample(0u); PV_NtcSample(1940u, 0u);
  assert(pv.ntc_valid && pv.surface_temperature == ambient);
  assert(PV_Telemetry(data, sizeof(data), 0u));
  assert(strstr(data, "\"surfaceTemp\":27.4") && strstr(data, "\"panelTemp\":23.4"));
  assert(strstr(data, "\"ntcStatus\":\"estimated\""));
  PV_NtcSample(1665u, 1u);
  assert(pv.ntc_valid && pv.surface_temperature == warmed);
  PV_NtcSample(0u, 2u);
  assert(!pv.ntc_valid && PV_Telemetry(data, sizeof(data), 2u) && strstr(data, "\"surfaceTemp\":null"));
  PV_NtcSample(1940u, 3u); PV_Tick(2004u);
  assert(!pv.ntc_valid && pv.ntc_adc == 0xFFFFu);
  assert(PV_Telemetry(data, sizeof(data), 2004u) && strstr(data, "\"surfaceTemp\":null"));
  PV_Init(UINT32_MAX - 100u, 0); PV_NtcSample(1940u, UINT32_MAX - 100u);
  PV_Tick(100u); assert(pv.ntc_valid);
  PV_Tick(2000u); assert(!pv.ntc_valid);
  /* NTC readout is independent of the SHT20 channel, not a replacement for it. */
  PV_Init(0u, 0); PV_Sample(0u, 0u, 0u, 0u, 0u); PV_NtcSample(1940u, 0u);
  assert(PV_Telemetry(data, sizeof(data), 0u) && strstr(data, "\"panelTemp\":null") && strstr(data, "\"surfaceTemp\":27.4"));
  puts("NTC tests passed (configurable estimate, 1940/1665, midpoint/range/rails, independent SHT20, expiry/wraparound).");
}
int main(int argc, char **argv)
{
  uint32_t t;
  PV_Settings cfg = {1000u, 40u, 65u, 10u, 60u};
  PV_Record record;
  if (argc > 1 && !strcmp(argv[1], "--pir-protocol"))
  {
    PV_Init(0u, 0); sample(0u);
    PV_PirSample(PV_PIR_WARMING, 0u, 60u, 0u); PV_Tick(0u);
    PV_NtcSample(1940u, 0u);
    assert(PV_Telemetry(data, sizeof(data), 0u)); fputs(data, stdout);
    PV_PirSample(PV_PIR_OK, 1u, 0u, 100u); PV_Tick(100u);
    assert(PV_Telemetry(data, sizeof(data), 100u)); fputs(data, stdout);
    request("pirAlarm", 0u, 100u); fputs(ack, stdout);
    assert(PV_Telemetry(data, sizeof(data), 100u)); fputs(data, stdout);
    snprintf(command, sizeof(command), "{\"type\":\"cmd\",\"cmdId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"action\":\"pirAlarm\",\"value\":1}");
    assert(PV_Command(command, ack, sizeof(ack), 100u)); fputs(ack, stdout);
    assert(PV_Telemetry(data, sizeof(data), 100u)); fputs(data, stdout);
    PV_Sample(3000u, 0x6664u, 1u, 7u, 200u); PV_Tick(200u);
    assert(!strcmp(PV_Apply("pirAlarm", 0u, 200u), "OK"));
    assert(PV_Telemetry(data, sizeof(data), 200u)); fputs(data, stdout);
    PV_Sample(3000u, 0u, 0u, 0u, 300u); pv.temperature_status = PV_TEMP_MISSING;
    PV_PirSample(PV_PIR_UNAVAILABLE, 0u, 0u, 300u); PV_Tick(300u);
    assert(PV_Telemetry(data, sizeof(data), 300u)); fputs(data, stdout);
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "--protocol"))
  {
    PV_Init(0u, 0); sample(0u);
    assert(PV_Telemetry(data, sizeof(data), 1000u));
    fputs(data, stdout);
    request("angle", 45u, 1000u);
    fputs(ack, stdout);
    return 0;
  }
  PV_Init(0u, 0);
  assert(pv.angle == 0u && pv.target == 0u && !pv.cleaning && !pv.automatic);
  assert(!strcmp(PV_Apply("clean", 1u, 0u), "SENSOR_FAULT"));
  sample(1u);
  assert(pv.current >= 238u && pv.current <= 240u);
  assert(!strcmp(PV_Apply("mode", 1u, 1u), "BASELINE_REQUIRED"));
  assert(!strcmp(PV_Apply("angle", 91u, 1u), "OUT_OF_RANGE"));
  assert(!strcmp(PV_Apply("angle", 90u, 1u), "OK"));
  for (t = 20u; t <= 1800u; t += 20u) PV_Tick(t);
  assert(pv.angle == 90u);
  assert(!strcmp(PV_Apply("clean", 1u, 1800u), "OK"));
  for (t = 2000u; t <= 12000u; t += 1000u) { sample(t); PV_Tick(t); }
  assert(!pv.cleaning);
  PV_Sample(3000u, 0x6664u, 1u, 7u, 12000u);
  assert(!strcmp(PV_Apply("clean", 1u, 12000u), "RAIN_INTERLOCK"));
  assert(PV_Telemetry(data, sizeof(data), 12000u) && strstr(data, "\"rain\":100"));
  sample(12001u);
  assert(PV_Telemetry(data, sizeof(data), 12001u) && strstr(data, "\"rain\":0"));
  assert(!strcmp(PV_Apply("clean", 1u, 12001u), "RAIN_RECOVERY"));
  PV_Sample(3000u, 0x6664u, 1u, 7u, 12002u); PV_Tick(12002u);
  assert(!pv.cleaning && (pv.alarm & 4u));
  PV_Init(12002u, 0);
  for (t = 13000u; t < 16000u; t += 100u) PV_Sample(3000u, 0xC000u, 0u, 7u, t);
  assert(!strcmp(PV_Apply("clean", 1u, 16000u), "TEMP_INTERLOCK"));
  PV_Init(0u, 0); sample(0u);
  request("save", 1u, 1u);
  assert(strstr(ack, "\"accepted\":true") && saves == 1u && pv.saved);
  assert(PV_Command(command, ack, sizeof(ack), 2u) && saves == 1u);
  request("angle", 50u, 2u);
  assert(strstr(ack, "ID_CONFLICT") && pv.target == 0u);
  assert(PV_Telemetry(data, sizeof(data), 1000u));
  assert(strstr(data, "\"protocol\":3") && strstr(data, "\"quality\":\"uncalibrated\""));
  assert(!PV_Telemetry(data, 8u, 1000u));

  PV_Init(0u, 0); sample(0u);
  snprintf(command, sizeof(command), "{\"type\":\"cmd\",\"cmdId\":\"%s\",\"action\":\"settings\",\"dustThreshold\":45,\"tempThreshold\":70,\"cleanSeconds\":12,\"autoCooldownS\":120}", id);
  assert(PV_Command(command, ack, sizeof(ack), 1u));
  assert(strstr(ack, "\"applied\":true") && pv.cfg.dust_threshold == 45u && pv.cfg.clean_seconds == 12u && !pv.saved);
  PV_Init(0u, 0); sample(0u);
  snprintf(command, sizeof(command), "{\"type\":\"cmd\",\"cmdId\":\"%s\",\"action\":\"settings\",\"dustThreshold\":45,\"tempThreshold\":70,\"cleanSeconds\":999,\"autoCooldownS\":120}", id);
  assert(PV_Command(command, ack, sizeof(ack), 1u));
  assert(strstr(ack, "OUT_OF_RANGE") && pv.cfg.dust_threshold == 40u);
  {
    const char *bad[] = {
      "[]", "{}", "not json", "{", "{\"type\":\"cmd\",\"cmdId\":\"bad\",\"action\":\"clean\",\"value\":1}",
      "{\"type\":\"cmd\" \"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":1}",
      "{\"type\":\"cmd\",\"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":1,}",
      "{\"type\":\"cmd\",\"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":-1}",
      "{\"type\":\"cmd\",\"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":1,\"value\":0}",
      "{\"type\":\"cmd\",\"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":1.2}",
      "{\"type\":\"cmd\",\"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":true}",
      "{\"type\":\"cmd\",\"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":{}}",
      "{\"type\":\"cmd\",\"cmdId\":\"0123456789abcdef0123456789abcdef\",\"action\":\"clean\",\"value\":1} garbage"
    };
    size_t i;
    for (i = 0u; i < sizeof(bad) / sizeof(bad[0]); i++) {
      PV_Init(0u, 0); sample(0u);
      if (PV_Command(bad[i], ack, sizeof(ack), 1u)) assert(!strstr(ack, "\"applied\":true"));
      assert(!pv.cleaning && pv.target == 0u);
    }
  }
  PV_Init(0u, &cfg);
  PV_Sample(1500u, 0x6664u, 0u, 7u, 0u);
  assert(!strcmp(PV_Apply("mode", 1u, 0u), "OK"));
  for (t = 0u; t <= 30000u; t += 1000u) { PV_Sample(1500u, 0x6664u, 0u, 7u, t); PV_Tick(t); }
  assert(pv.cleaning);
  for (t = 31000u; t <= 99000u; t += 1000u) { PV_Sample(1500u, 0x6664u, 0u, 7u, t); PV_Tick(t); assert(!pv.cleaning || t < 40000u); }
  PV_Sample(1500u, 0x6664u, 0u, 7u, 100000u); PV_Tick(100000u); assert(pv.cleaning);
  PV_Init(0u, &cfg);
  PV_Sample(0u, 0x6664u, 0u, 7u, 0u);
  assert(!strcmp(PV_Apply("mode", 1u, 0u), "OK"));
  for (t = 0u; t < 100000u; t += 1000u) { PV_Sample(0u, 0x6664u, 0u, 7u, t); PV_Tick(t); }
  assert(!pv.cleaning && !(pv.alarm & 1u));
  assert(PV_Telemetry(data, sizeof(data), t) && strstr(data, "low_current"));
  PV_Init(UINT32_MAX - 500u, 0); sample(UINT32_MAX - 500u);
  assert(!strcmp(PV_Apply("clean", 1u, UINT32_MAX - 500u), "OK"));
  PV_Sample(3000u, 0x6664u, 1u, 7u, 100u); PV_Tick(100u); assert(!pv.cleaning);
  PV_Init(0u, &cfg); sample(0u);
  assert(!strcmp(PV_Apply("clean", 1u, 0u), "OK"));
  PV_Sample(2000u, 0u, 0u, 0u, 250u); pv.temperature_status = PV_TEMP_MISSING; PV_Tick(250u);
  assert(!pv.sensor_ok && !pv.cleaning);
  assert(PV_Telemetry(data, sizeof(data), 250u));
  assert(strstr(data, "\"current\":null") && strstr(data, "\"panelTemp\":null") && strstr(data, "\"rain\":null"));
  assert(!strcmp(PV_Apply("baseline", 1u, 250u), "SENSOR_FAULT"));
  PV_Sample(3000u, 0x6664u, 0u, 3u, 500u);
  assert(!strcmp(PV_Apply("clean", 1u, 500u), "RAIN_UNAVAILABLE"));
  assert(!strcmp(PV_Apply("mode", 1u, 500u), "RAIN_UNAVAILABLE"));
  assert(PV_Telemetry(data, sizeof(data), 500u) && strstr(data, "\"rain\":null"));
  PV_Sample(4095u, 0x6664u, 0u, 7u, 750u);
  assert(!(pv.valid_flags & PV_VALID_CURRENT));
  sample(1000u); PV_Tick(3001u);
  assert(!pv.valid_flags && !pv.sensor_ok);
  assert(PV_CurrentMa(0u) == 0u && PV_CurrentMa(4095u) == 327u);
  assert(PV_TemperatureDeci(0x6664u) == 234);
  assert(PV_TemperatureDeci(0x4000u) == -29);
  PV_Sample(3000u, 0x4000u, 0u, 7u, 4000u);
  assert(PV_Telemetry(data, sizeof(data), 4000u) && strstr(data, "\"panelTemp\":-2.9"));
  assert(PV_Crc32("123456789", 9u) == 0xCBF43926u);
  assert(sizeof(PV_Record) == 64u);
  memset(&record, 0xFF, sizeof(record));
  record.magic = 0x50565332u; record.version = PV_STORE_VERSION; record.sequence = 1u; record.cfg = cfg;
  record.crc = PV_Crc32(&record, offsetof(PV_Record, crc));
  assert(!PV_RecordValid(&record));
  record.committed = 0x434F4D54u; assert(PV_RecordValid(&record));
  record.version = 2u; record.crc = PV_Crc32(&record, offsetof(PV_Record, crc)); assert(!PV_RecordValid(&record));
  record.version = PV_STORE_VERSION; record.crc = PV_Crc32(&record, offsetof(PV_Record, crc)); assert(PV_RecordValid(&record));
  record.cfg.clean_seconds++; assert(!PV_RecordValid(&record));
  rain_tests();
  pir_tests();
  ntc_tests();
  puts("PASS: rain shield/recovery, STOP latch/resume, wet/unknown/stale/wraparound, safety interlocks, timed cleaning, auto cooldown, ACK/dedup, settings and CRC commit validation.");
  return 0;
}
