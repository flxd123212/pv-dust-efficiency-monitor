#ifndef PV_APP_H
#define PV_APP_H

#include <stdint.h>
#include <stddef.h>
#include "pv_sensors.h"

#define PV_STOW_ANGLE 0u
#define PV_RAIN_ANGLE 90u
#define PV_RAIN_DRY_HOLD_MS 10000u
#define PV_TELEMETRY_CAPACITY 1024u
enum { PV_RAIN_IDLE, PV_RAIN_WET, PV_RAIN_DRYING, PV_RAIN_RETURNING };

typedef struct {
  uint32_t baseline_ma;
  uint32_t dust_threshold;
  uint32_t temp_threshold;
  uint32_t clean_seconds;
  uint32_t cooldown_s;
} PV_Settings;

typedef struct {
  PV_Settings cfg;
  uint16_t current, rain, dust, angle, target;
  int16_t temperature;
  uint16_t adc_current, adc_voltage, temperature_raw;
  uint8_t cleaning, automatic, sensor_ok, saved, valid_flags, temperature_status;
  uint8_t rain_state, motion_paused;
  uint8_t pir_status, person_detected, pir_warmup_s, pir_alarm_enabled;
  uint16_t ntc_adc;
  int16_t surface_temperature;
  uint8_t ntc_valid;
  uint32_t pir_at, ntc_at;
  uint32_t rain_dry_at;
  uint32_t alarm, seq, sample_at, clean_at, stopped_at, step_at, dust_at, muted_until;
} PV_State;

extern PV_State pv;
void PV_Init(uint32_t now, const PV_Settings *settings);
int PV_SettingsValid(const PV_Settings *settings);
void PV_Sample(uint16_t adc_current, uint16_t temperature_raw, uint8_t rain,
               uint8_t valid_flags, uint32_t now);
void PV_Tick(uint32_t now);
void PV_PirSample(uint8_t status, uint8_t detected, uint32_t remaining_s, uint32_t now);
void PV_NtcSample(uint16_t adc, uint32_t now);
const char *PV_Apply(const char *action, uint32_t value, uint32_t now);
int PV_Command(const char *json, char *ack, size_t capacity, uint32_t now);
int PV_Telemetry(char *buffer, size_t capacity, uint32_t now);
int PV_AlarmAudible(uint32_t now);
const char *PV_RainStatus(void);
uint32_t PV_RainDryRemaining(uint32_t now);
int PV_LedOn(uint32_t now);
const char *PV_LedMode(void);
const char *PV_LocalStopAction(void);
int PV_StoreWrite(const PV_Settings *settings);

#endif
