#ifndef PV_SENSORS_H
#define PV_SENSORS_H
#include <stdint.h>

#define PV_VALID_CURRENT 1u
#define PV_VALID_TEMP 2u
#define PV_VALID_RAIN 4u
/* External rain module: 3.3 V DO -> PA4, active low; PA1 remains untouched. */
#define PV_RAIN_PA4_ENABLED 1u
#define PV_RAIN_DRY_MS 500u
#define PV_PIR_WARMUP_MS 60000u
#define PV_PIR_CLEAR_MS 5000u
/* Starting model only: verify the actual NTC/divider before claiming accuracy. */
#define PV_NTC_FIXED_OHMS 10000.0f
#define PV_NTC_R25_OHMS 10000.0f
#define PV_NTC_BETA_K 3950.0f
#define PV_NTC_MIN_DECI 200
#define PV_NTC_MAX_DECI 800
enum { PV_PIR_WARMING, PV_PIR_OK, PV_PIR_UNAVAILABLE };
enum { PV_TEMP_PENDING, PV_TEMP_OK, PV_TEMP_MISSING, PV_TEMP_CRC, PV_TEMP_TIMEOUT };

uint16_t PV_CurrentMa(uint16_t adc);
int PV_NtcTemperatureDeci(uint16_t adc, int16_t *temperature);
int16_t PV_TemperatureDeci(uint16_t raw);
int PV_ShtDecode(const uint8_t bytes[3], uint16_t *raw);
void PV_SensorsInit(void);
void PV_SensorsPoll(uint32_t now);
int PV_RainRead(uint32_t now, uint8_t *rain);
int PV_TemperatureRead(uint32_t now, uint16_t *raw);
uint8_t PV_TemperatureStatus(void);
int PV_PirRead(uint32_t now, uint8_t *detected);
uint8_t PV_PirStatus(uint32_t now);
uint32_t PV_PirWarmupRemaining(uint32_t now);
#endif
