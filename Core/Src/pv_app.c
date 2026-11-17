#include "pv_app.h"
#include <stdio.h>
#include <string.h>
#define JSMN_STATIC
#define JSMN_STRICT
#include "jsmn.h"

PV_State pv;
static uint8_t sampled, dust_pending, muted;
static unsigned int cache_next;
static struct {
  char id[33];
  uint32_t hash;
  const char *reason;
} cache[8];

int PV_SettingsValid(const PV_Settings *s)
{
  return s->baseline_ma <= 2000u && s->dust_threshold >= 10u && s->dust_threshold <= 90u &&
    s->temp_threshold >= 35u && s->temp_threshold <= 90u &&
    s->clean_seconds >= 3u && s->clean_seconds <= 30u &&
    s->cooldown_s >= 60u && s->cooldown_s <= 3600u;
}

void PV_Init(uint32_t now, const PV_Settings *settings)
{
  static const PV_Settings defaults = {0u, 40u, 65u, 10u, 900u};
  memset(&pv, 0, sizeof(pv));
  memset(cache, 0, sizeof(cache));
  cache_next = 0u;
  sampled = dust_pending = muted = 0u;
  pv.cfg = (settings && PV_SettingsValid(settings)) ? *settings : defaults;
  pv.saved = settings && PV_SettingsValid(settings);
  pv.angle = pv.target = PV_STOW_ANGLE;
  pv.pir_status = PV_PIR_UNAVAILABLE;
  pv.pir_alarm_enabled = 1u;
  pv.ntc_adc = 0xFFFFu;
  pv.ntc_at = now;
  pv.pir_at = now;
  pv.sample_at = pv.step_at = now;
  pv.stopped_at = now - pv.cfg.cooldown_s * 1000u;
}

static const char *clean_allowed(void)
{
  if (pv.motion_paused) return "MOTION_PAUSED";
  if (!pv.sensor_ok) return "SENSOR_FAULT";
  if (!(pv.valid_flags & PV_VALID_RAIN)) return "RAIN_UNAVAILABLE";
  if (pv.rain) return "RAIN_INTERLOCK";
  if (pv.rain_state != PV_RAIN_IDLE) return "RAIN_RECOVERY";
  if (pv.temperature >= (int32_t)pv.cfg.temp_threshold * 10) return "TEMP_INTERLOCK";
  if (pv.angle != pv.target) return "BUSY";
  return "OK";
}

static void expire_sample(uint32_t now)
{
  if (now - pv.sample_at > 2000u) { pv.sensor_ok = 0u; pv.valid_flags = 0u; sampled = 0u; }
  if (now - pv.pir_at > 2000u)
  {
    pv.pir_status = PV_PIR_UNAVAILABLE;
    pv.person_detected = pv.pir_warmup_s = 0u;
    pv.alarm &= ~16u;
  }
  if (now - pv.ntc_at > 2000u) { pv.ntc_valid = 0u; pv.ntc_adc = 0xFFFFu; }
}

void PV_NtcSample(uint16_t adc, uint32_t now)
{
  pv.ntc_adc = adc;
  pv.ntc_at = now;
  pv.ntc_valid = (uint8_t)PV_NtcTemperatureDeci(adc, &pv.surface_temperature);
}

void PV_PirSample(uint8_t status, uint8_t detected, uint32_t remaining_s, uint32_t now)
{
  pv.pir_status = status <= PV_PIR_UNAVAILABLE ? status : PV_PIR_UNAVAILABLE;
  pv.person_detected = pv.pir_status == PV_PIR_OK && detected ? 1u : 0u;
  pv.pir_warmup_s = pv.pir_status == PV_PIR_WARMING ? (uint8_t)(remaining_s > 60u ? 60u : remaining_s ? remaining_s : 1u) : 0u;
  pv.pir_at = now;
}

const char *PV_LocalStopAction(void) { return pv.motion_paused ? "resume" : "stop"; }

const char *PV_LedMode(void)
{
  return pv.alarm ? "alarm" : pv.cleaning ? "cleaning" : pv.motion_paused ? "paused" : "idle";
}

int PV_LedOn(uint32_t now)
{
  if (pv.alarm) return now % 500u < 250u;
  if (pv.cleaning) return 1;
  return pv.motion_paused && now % 1000u < 100u;
}

static void stop_cleaner(uint32_t now)
{
  if (pv.cleaning) pv.stopped_at = now;
  pv.cleaning = 0u;
}

static void rain_update(uint32_t now)
{
  if (!(pv.valid_flags & PV_VALID_RAIN))
  {
    if (pv.rain_state != PV_RAIN_IDLE)
    {
      pv.rain_state = PV_RAIN_WET;
      pv.target = pv.angle;
    }
    return;
  }
  if (pv.rain)
  {
    stop_cleaner(now);
    pv.automatic = dust_pending = 0u;
    pv.rain_state = PV_RAIN_WET;
    if (!pv.motion_paused) pv.target = PV_RAIN_ANGLE;
  }
  else
  {
    if (pv.rain_state == PV_RAIN_WET)
    {
      pv.rain_state = PV_RAIN_DRYING;
      pv.rain_dry_at = now;
    }
    if (!pv.motion_paused && pv.rain_state == PV_RAIN_DRYING)
    {
      pv.target = PV_RAIN_ANGLE;
      if (now - pv.rain_dry_at >= PV_RAIN_DRY_HOLD_MS) pv.rain_state = PV_RAIN_RETURNING;
    }
    if (!pv.motion_paused && pv.rain_state == PV_RAIN_RETURNING)
    {
      pv.target = PV_STOW_ANGLE;
      if (pv.angle == PV_STOW_ANGLE) pv.rain_state = PV_RAIN_IDLE;
    }
  }
}

const char *PV_RainStatus(void)
{
  static const char *states[] = {"idle", "rain", "drying", "returning"};
  return (pv.valid_flags & PV_VALID_RAIN) ? states[pv.rain_state] : "unavailable";
}

uint32_t PV_RainDryRemaining(uint32_t now)
{
  uint32_t elapsed = now - pv.rain_dry_at;
  if (!(pv.valid_flags & PV_VALID_RAIN) || pv.rain_state != PV_RAIN_DRYING || elapsed >= PV_RAIN_DRY_HOLD_MS) return 0u;
  return (PV_RAIN_DRY_HOLD_MS - elapsed + 999u) / 1000u;
}

const char *PV_Apply(const char *action, uint32_t value, uint32_t now)
{
  const char *reason;
  expire_sample(now);
  rain_update(now);
  if (!strcmp(action, "pirAlarm"))
  {
    if (value > 1u) return "OUT_OF_RANGE";
    pv.pir_alarm_enabled = (uint8_t)value;
    pv.alarm = (pv.alarm & ~16u) | ((value && pv.pir_status == PV_PIR_OK && pv.person_detected) ? 16u : 0u);
  }
  else if (!strcmp(action, "angle"))
  {
    if (value > 90u) return "OUT_OF_RANGE";
    if (pv.motion_paused) return "MOTION_PAUSED";
    if (!(pv.valid_flags & PV_VALID_RAIN)) return "RAIN_UNAVAILABLE";
    if (pv.rain_state != PV_RAIN_IDLE && (value != PV_RAIN_ANGLE || pv.rain_state == PV_RAIN_RETURNING))
      return pv.rain ? "RAIN_INTERLOCK" : "RAIN_RECOVERY";
    pv.target = (uint16_t)value;
  }
  else if (!strcmp(action, "clean"))
  {
    if (value > 1u) return "OUT_OF_RANGE";
    if (!value) stop_cleaner(now);
    else
    {
      reason = clean_allowed();
      if (strcmp(reason, "OK")) return reason;
      if (!pv.cleaning) { pv.cleaning = 1u; pv.clean_at = now; }
    }
  }
  else if (!strcmp(action, "mode"))
  {
    if (value > 1u) return "OUT_OF_RANGE";
    if (value && pv.cfg.baseline_ma < 50u) return "BASELINE_REQUIRED";
    if (value) { reason = clean_allowed(); if (strcmp(reason, "OK")) return reason; }
    pv.automatic = (uint8_t)value;
    dust_pending = 0u;
    if (!value) stop_cleaner(now);
  }
  else if (!strcmp(action, "silence"))
  {
    if (value != 1u) return "OUT_OF_RANGE";
    pv.muted_until = now + 60000u;
    muted = 1u;
  }
  else if (!strcmp(action, "stop"))
  {
    if (value != 1u) return "OUT_OF_RANGE";
    stop_cleaner(now);
    pv.automatic = 0u;
    pv.target = pv.angle;
    pv.motion_paused = 1u;
    dust_pending = 0u;
  }
  else if (!strcmp(action, "resume"))
  {
    if (value != 1u) return "OUT_OF_RANGE";
    if (!(pv.valid_flags & PV_VALID_RAIN)) return "RAIN_UNAVAILABLE";
    pv.motion_paused = 0u;
    rain_update(now);
  }
  else if (!strcmp(action, "baseline"))
  {
    if (value != 1u) return "OUT_OF_RANGE";
    if (pv.cleaning) return "BUSY";
    reason = clean_allowed();
    if (strcmp(reason, "OK")) return reason;
    if (pv.current < 50u) return "LOW_CURRENT";
    pv.cfg.baseline_ma = pv.current;
    pv.dust = 0u;
    pv.saved = 0u;
    dust_pending = 0u;
  }
  else if (!strcmp(action, "save"))
  {
    if (value != 1u) return "OUT_OF_RANGE";
    if (pv.cleaning) return "BUSY";
    if (!pv.saved && !PV_StoreWrite(&pv.cfg)) return "SAVE_FAILED";
    pv.saved = 1u;
  }
  else return "INVALID_COMMAND";
  return "OK";
}

void PV_Sample(uint16_t adc_current, uint16_t temperature_raw, uint8_t rain,
               uint8_t valid_flags, uint32_t now)
{
  uint32_t current = PV_CurrentMa(adc_current);
  expire_sample(now);
  rain_update(now);
  pv.adc_current = adc_current;
  pv.temperature_raw = temperature_raw;
  pv.valid_flags = valid_flags & 7u;
  if (adc_current >= 4080u) pv.valid_flags = (uint8_t)(pv.valid_flags & (7u ^ PV_VALID_CURRENT));
  pv.sensor_ok = (pv.valid_flags & 3u) == 3u;
  pv.sample_at = now;
  pv.rain = (pv.valid_flags & PV_VALID_RAIN) && rain ? 100u : 0u;
  if (pv.valid_flags & PV_VALID_CURRENT)
  {
    pv.current = (uint16_t)(sampled ? (3u * pv.current + current) / 4u : current);
    sampled = 1u;
  }
  else { pv.current = 0u; sampled = 0u; }
  if (pv.valid_flags & PV_VALID_TEMP) { pv.temperature = PV_TemperatureDeci(temperature_raw); pv.temperature_status = PV_TEMP_OK; }
  if ((pv.valid_flags & PV_VALID_CURRENT) && pv.cfg.baseline_ma >= 50u && pv.current < pv.cfg.baseline_ma)
    pv.dust = (uint16_t)(100u - (uint32_t)pv.current * 100u / pv.cfg.baseline_ma);
  else pv.dust = 0u;
  rain_update(now);
}

void PV_Tick(uint32_t now)
{
  uint8_t dust_alarm;
  if (muted && (int32_t)(now - pv.muted_until) >= 0) muted = 0u;
  expire_sample(now);
  rain_update(now);
  dust_alarm = pv.sensor_ok && pv.cfg.baseline_ma >= 50u && pv.current >= 50u &&
               pv.dust >= pv.cfg.dust_threshold;
  pv.alarm = (dust_alarm ? 1u : 0u) |
    (((pv.valid_flags & PV_VALID_TEMP) && pv.temperature >= (int32_t)pv.cfg.temp_threshold * 10) ? 2u : 0u) |
    (((pv.valid_flags & PV_VALID_RAIN) && pv.rain) ? 4u : 0u) |
    ((!pv.sensor_ok || !(pv.valid_flags & PV_VALID_RAIN)) ? 8u : 0u) |
    ((pv.pir_alarm_enabled && pv.pir_status == PV_PIR_OK && pv.person_detected) ? 16u : 0u);
  if (pv.cleaning && (strcmp(clean_allowed(), "OK") || now - pv.clean_at >= pv.cfg.clean_seconds * 1000u))
    stop_cleaner(now);
  if (pv.automatic && dust_alarm && !strcmp(clean_allowed(), "OK") && !pv.cleaning)
  {
    if (!dust_pending) { dust_pending = 1u; pv.dust_at = now; }
    if (now - pv.dust_at >= 30000u && now - pv.stopped_at >= pv.cfg.cooldown_s * 1000u)
    {
      (void)PV_Apply("clean", 1u, now);
      dust_pending = 0u;
    }
  }
  else dust_pending = 0u;
  if (now - pv.step_at >= 20u)
  {
    pv.step_at = now;
    if (pv.angle < pv.target) pv.angle++;
    else if (pv.angle > pv.target) pv.angle--;
  }
}

int PV_AlarmAudible(uint32_t now)
{
  return pv.alarm && !muted && now % 1000u < 120u;
}

static int token_equals(const char *json, const jsmntok_t *t, const char *s)
{
  return t->type == JSMN_STRING && (int)strlen(s) == t->end - t->start &&
    !strncmp(json + t->start, s, (size_t)(t->end - t->start));
}

static int integer(const char *json, const jsmntok_t *t, uint32_t *value)
{
  int i;
  uint32_t v = 0u;
  if (t->type != JSMN_PRIMITIVE || t->end <= t->start || t->end - t->start > 6) return 0;
  if (t->end - t->start > 1 && json[t->start] == '0') return 0;
  for (i = t->start; i < t->end; i++)
  {
    if (json[i] < '0' || json[i] > '9') return 0;
    v = v * 10u + (uint32_t)(json[i] - '0');
  }
  *value = v;
  return 1;
}

static int separator(const char *json, int start, int end, char expected)
{
  int found = 0, i;
  if (start > end) return 0;
  for (i = start; i < end; i++)
  {
    char ch = json[i];
    if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') continue;
    if (!expected || ch != expected || found) return 0;
    found = 1;
  }
  return expected ? found : !found;
}

int PV_Command(const char *json, char *ack, size_t capacity, uint32_t now)
{
  jsmn_parser parser;
  jsmntok_t t[32];
  PV_Settings settings = pv.cfg;
  const char *reason = "INVALID_COMMAND";
  char id[33] = "", action[20] = "";
  uint32_t value = 0u, hash = 2166136261u;
  unsigned int mask = 0u;
  int count, i, j, valid = 1, written, previous = 0;
  size_t length = strlen(json);
  if (length > 511u) return 0;
  jsmn_init(&parser);
  count = jsmn_parse(&parser, json, length, t, 32u);
  if (count < 1 || t[0].type != JSMN_OBJECT || !(count & 1)) valid = 0;
  if (valid)
  {
    previous = t[0].start + 1;
    for (i = 0; i < t[0].start; i++) if (json[i] != ' ' && json[i] != '\t' && json[i] != '\r' && json[i] != '\n') valid = 0;
    for (i = t[0].end; (size_t)i < length; i++) if (json[i] != ' ' && json[i] != '\t' && json[i] != '\r' && json[i] != '\n') valid = 0;
    for (i = 1; i + 1 < count; i += 2)
    {
      unsigned int bit = 0u;
      uint32_t number = 0u;
      if (t[i].type != JSMN_STRING || (t[i + 1].type != JSMN_STRING && t[i + 1].type != JSMN_PRIMITIVE)) { valid = 0; break; }
      if (!separator(json, previous, t[i].start - 1, i == 1 ? 0 : ',') ||
          !separator(json, t[i].end + 1, t[i + 1].start - (t[i + 1].type == JSMN_STRING ? 1 : 0), ':')) valid = 0;
      previous = t[i + 1].end + (t[i + 1].type == JSMN_STRING ? 1 : 0);
      if (token_equals(json, &t[i], "type")) { bit = 1u; if (!token_equals(json, &t[i + 1], "cmd")) valid = 0; }
      else if (token_equals(json, &t[i], "cmdId"))
      {
        bit = 2u;
        if (t[i + 1].type != JSMN_STRING || t[i + 1].end - t[i + 1].start != 32) valid = 0;
        else
        {
          for (j = 0; j < 32; j++)
          {
            char ch = json[t[i + 1].start + j];
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) valid = 0;
            id[j] = ch;
          }
          id[32] = 0;
        }
      }
      else if (token_equals(json, &t[i], "action"))
      {
        bit = 4u;
        j = t[i + 1].end - t[i + 1].start;
        if (t[i + 1].type != JSMN_STRING || j < 1 || j >= (int)sizeof(action)) valid = 0;
        else { memcpy(action, json + t[i + 1].start, (size_t)j); action[j] = 0; }
      }
      else
      {
        if (!integer(json, &t[i + 1], &number)) valid = 0;
        if (token_equals(json, &t[i], "value")) { bit = 8u; value = number; }
        else if (token_equals(json, &t[i], "dustThreshold")) { bit = 16u; settings.dust_threshold = number; }
        else if (token_equals(json, &t[i], "tempThreshold")) { bit = 32u; settings.temp_threshold = number; }
        else if (token_equals(json, &t[i], "cleanSeconds")) { bit = 64u; settings.clean_seconds = number; }
        else if (token_equals(json, &t[i], "autoCooldownS")) { bit = 128u; settings.cooldown_s = number; }
        else valid = 0;
      }
      if (mask & bit) valid = 0;
      mask |= bit;
    }
    if (!separator(json, previous, t[0].end - 1, 0)) valid = 0;
  }
  for (i = 0; (size_t)i < length; i++) hash = (hash ^ (uint8_t)json[i]) * 16777619u;
  if (valid && (mask == 15u || (mask == 247u && !strcmp(action, "settings"))))
  {
    for (i = 0; i < 8; i++)
      if (!strcmp(cache[i].id, id))
      {
        reason = cache[i].hash == hash ? cache[i].reason : "ID_CONFLICT";
        goto respond;
      }
    if (!strcmp(action, "settings"))
    {
      if (mask != 247u || !PV_SettingsValid(&settings)) reason = "OUT_OF_RANGE";
      else if (pv.cleaning) reason = "BUSY";
      else { pv.cfg = settings; pv.saved = 0u; dust_pending = 0u; reason = "OK"; }
    }
    else if (mask == 15u) reason = PV_Apply(action, value, now);
    strcpy(cache[cache_next].id, id);
    cache[cache_next].hash = hash;
    cache[cache_next].reason = reason;
    cache_next = (cache_next + 1u) % 8u;
  }
respond:
  /* Echo only a valid identifier, never untrusted JSON string content. */
  for (i = 0; id[i]; i++)
    if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) { id[0] = 0; break; }
  written = snprintf(ack, capacity, "{\"type\":\"ack\",\"cmdId\":\"%s\",\"accepted\":%s,\"applied\":%s,\"reason\":\"%s\"}\r\n",
    id, !strcmp(reason, "OK") ? "true" : "false", !strcmp(reason, "OK") ? "true" : "false", reason);
  return written > 0 && (size_t)written < capacity;
}

int PV_Telemetry(char *b, size_t capacity, uint32_t now)
{
  static const char *statuses[] = {"pending", "ok", "missing", "crc", "timeout"};
  static const char *pir_statuses[] = {"warming", "ok", "unavailable"};
  char current[12] = "null", temperature[12] = "null", rain[8] = "null", dust[8] = "null";
  char ntc[8] = "null";
  char surface[12] = "null";
  const char *quality;
  unsigned int magnitude;
  int n;
  expire_sample(now);
  rain_update(now);
  quality = pv.sensor_ok ? (pv.cfg.baseline_ma >= 50u ? (pv.current >= 50u ? "estimated" : "low_current") : "uncalibrated") : "invalid";
  if (pv.valid_flags & PV_VALID_CURRENT) (void)snprintf(current, sizeof(current), "%u", pv.current);
  if (pv.valid_flags & PV_VALID_TEMP)
  {
    magnitude = (unsigned int)(pv.temperature < 0 ? -pv.temperature : pv.temperature);
    (void)snprintf(temperature, sizeof(temperature), "%s%u.%u", pv.temperature < 0 ? "-" : "", magnitude / 10u, magnitude % 10u);
  }
  if (pv.valid_flags & PV_VALID_RAIN) (void)snprintf(rain, sizeof(rain), "%u", pv.rain);
  if (!strcmp(quality, "estimated")) (void)snprintf(dust, sizeof(dust), "%u", pv.dust);
  if (!(pv.valid_flags & PV_VALID_TEMP) && pv.temperature_status == PV_TEMP_OK) pv.temperature_status = PV_TEMP_TIMEOUT;
  if (pv.ntc_adc <= 4095u) (void)snprintf(ntc, sizeof(ntc), "%u", pv.ntc_adc);
  if (pv.ntc_valid) (void)snprintf(surface, sizeof(surface), "%u.%u", (unsigned int)pv.surface_temperature / 10u, (unsigned int)pv.surface_temperature % 10u);
  n = snprintf(b, capacity,
    "{\"type\":\"data\",\"protocol\":3,\"seq\":%lu,\"uptimeS\":%lu,\"current\":%s,\"panelTemp\":%s,\"rain\":%s,\"dustLevel\":%s,"
    "\"tiltAngle\":%u,\"targetAngle\":%u,\"cleaning\":%s,\"mode\":\"%s\",\"alarm\":%lu,\"quality\":\"%s\","
    "\"baselineMa\":%lu,\"dustThreshold\":%lu,\"tempThreshold\":%lu,\"cleanSeconds\":%lu,\"autoCooldownS\":%lu,"
    "\"adcCurrent\":%u,\"adcVoltage\":%u,\"temperatureRaw\":%u,\"validFlags\":%u,\"temperatureStatus\":\"%s\",\"saved\":%s,"
    "\"rainProtection\":\"%s\",\"rainDryRemainingS\":%lu,\"motionPaused\":%s,"
    "\"personDetected\":%s,\"pirStatus\":\"%s\",\"pirWarmupRemainingS\":%u,\"ld1Mode\":\"%s\",\"ntcAdc\":%s,\"ntcStatus\":\"%s\",\"surfaceTemp\":%s,\"pirAlarmEnabled\":%s}\r\n",
    (unsigned long)++pv.seq, (unsigned long)(now / 1000u), current, temperature, rain, dust,
    pv.angle, pv.target, pv.cleaning ? "true" : "false", pv.automatic ? "auto" : "manual", (unsigned long)pv.alarm,
    quality,
    (unsigned long)pv.cfg.baseline_ma, (unsigned long)pv.cfg.dust_threshold, (unsigned long)pv.cfg.temp_threshold,
    (unsigned long)pv.cfg.clean_seconds, (unsigned long)pv.cfg.cooldown_s, pv.adc_current, pv.adc_voltage,
    pv.temperature_raw, pv.valid_flags, statuses[pv.temperature_status <= PV_TEMP_TIMEOUT ? pv.temperature_status : PV_TEMP_TIMEOUT],
    pv.saved ? "true" : "false", PV_RainStatus(), (unsigned long)PV_RainDryRemaining(now), pv.motion_paused ? "true" : "false",
    pv.pir_status == PV_PIR_OK ? (pv.person_detected ? "true" : "false") : "null",
    pir_statuses[pv.pir_status], pv.pir_warmup_s, PV_LedMode(), ntc, pv.ntc_valid ? "estimated" : "invalid", surface, pv.pir_alarm_enabled ? "true" : "false");
  return n > 0 && (size_t)n < capacity;
}
