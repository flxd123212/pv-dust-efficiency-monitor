#include "pv_sensors.h"
#include <math.h>

int PV_NtcTemperatureDeci(uint16_t adc, int16_t *temperature)
{
  float resistance, kelvin, deci;
  if (!temperature || !adc || adc >= 4095u) return 0;
  resistance = PV_NTC_FIXED_OHMS * (float)adc / (4095.0f - (float)adc);
  kelvin = 1.0f / (1.0f / 298.15f + logf(resistance / PV_NTC_R25_OHMS) / PV_NTC_BETA_K);
  deci = (kelvin - 273.15f) * 10.0f;
  if (!(deci >= PV_NTC_MIN_DECI - 0.5f && deci < PV_NTC_MAX_DECI + 0.5f)) return 0;
  *temperature = (int16_t)(deci + 0.5f);
  return 1;
}

uint16_t PV_CurrentMa(uint16_t adc)
{
  /* 3.3 V ADC, R54=0.1 ohm, U12A gain=1+100k/1k=101. */
  return (uint16_t)(((uint32_t)adc * 33000u + 206797u) / 413595u);
}
int16_t PV_TemperatureDeci(uint16_t raw)
{
  int32_t centi = (int32_t)(((uint32_t)(raw & 0xFFFCu) * 17572u + 32768u) / 65536u) - 4685;
  return (int16_t)((centi + (centi >= 0 ? 5 : -5)) / 10);
}
int PV_ShtDecode(const uint8_t bytes[3], uint16_t *raw)
{
  uint8_t crc = 0u;
  unsigned int i, bit;
  int16_t temperature;
  for (i = 0u; i < 2u; i++)
  {
    crc ^= bytes[i];
    for (bit = 0u; bit < 8u; bit++) crc = (uint8_t)((crc & 0x80u) ? (crc << 1) ^ 0x31u : crc << 1);
  }
  if (crc != bytes[2] || (bytes[1] & 2u)) return 0;
  *raw = (uint16_t)(((uint16_t)bytes[0] << 8 | bytes[1]) & 0xFFFCu);
  temperature = PV_TemperatureDeci(*raw);
  return temperature >= -400 && temperature <= 1250;
}
