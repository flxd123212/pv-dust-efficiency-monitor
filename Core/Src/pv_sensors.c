#include "main.h"
#include "pv_sensors.h"
#include <string.h>

static I2C_HandleTypeDef sensor_i2c;
static uint32_t started_at, last_good;
static uint16_t temperature_raw;
static uint8_t pending, valid, ready, status;
static uint32_t rain_polled_at, rain_dry_at;
static uint8_t rain_valid, rain_wet, rain_dry_pending;
static uint32_t pir_polled_at, pir_started_at, pir_low_at;
static uint8_t pir_board_seen, pir_active, pir_low_pending;

void PV_SensorsInit(void)
{
  GPIO_InitTypeDef g = {0};
  if (PV_RAIN_PA4_ENABLED)
  {
    __HAL_RCC_GPIOA_CLK_ENABLE();
    g.Pin = GPIO_PIN_4;
    g.Mode = GPIO_MODE_INPUT;
    /* A floating/disconnected DO must not release the rain interlock. */
    g.Pull = GPIO_PULLDOWN;
    HAL_GPIO_Init(GPIOA, &g);
  }
  rain_valid = rain_dry_pending = 0u;
  rain_wet = 1u;
  rain_polled_at = HAL_GetTick();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  g.Pin = GPIO_PIN_4;
  g.Mode = GPIO_MODE_INPUT;
  g.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOB, &g);
  pir_board_seen = pir_active = pir_low_pending = 0u;
  pir_polled_at = HAL_GetTick();
  __HAL_RCC_I2C1_CLK_ENABLE();
  g.Pin = GPIO_PIN_6 | GPIO_PIN_7;
  g.Mode = GPIO_MODE_AF_OD;
  g.Pull = GPIO_PULLUP;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  g.Alternate = GPIO_AF4_I2C1;
  HAL_GPIO_Init(GPIOB, &g);
  memset(&sensor_i2c, 0, sizeof(sensor_i2c));
  sensor_i2c.Instance = I2C1;
  sensor_i2c.Init.ClockSpeed = 100000u;
  sensor_i2c.Init.DutyCycle = I2C_DUTYCYCLE_2;
  sensor_i2c.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  sensor_i2c.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
  sensor_i2c.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
  sensor_i2c.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
  ready = HAL_I2C_Init(&sensor_i2c) == HAL_OK;
  pending = valid = 0u;
  status = PV_TEMP_PENDING;
  started_at = HAL_GetTick() - 1000u;
}
static void rain_poll(uint32_t now)
{
  if (!PV_RAIN_PA4_ENABLED) return;
  if (now - rain_polled_at > 1000u) { rain_valid = rain_dry_pending = 0u; }
  rain_polled_at = now;
  if (HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_4) == GPIO_PIN_RESET)
  {
    rain_wet = rain_valid = 1u;
    rain_dry_pending = 0u;
  }
  else
  {
    if (!rain_dry_pending) { rain_dry_pending = 1u; rain_dry_at = now; }
    if (now - rain_dry_at >= PV_RAIN_DRY_MS) { rain_wet = 0u; rain_valid = 1u; }
  }
}
int PV_RainRead(uint32_t now, uint8_t *rain)
{
  if (!PV_RAIN_PA4_ENABLED || !rain_valid || now - rain_polled_at > 1000u) return 0;
  *rain = rain_wet;
  return 1;
}
static void pir_poll(uint32_t now)
{
  uint16_t raw;
  if (now - pir_polled_at > 1000u) pir_board_seen = 0u;
  pir_polled_at = now;
  if (!PV_TemperatureRead(now, &raw))
  {
    pir_board_seen = pir_active = pir_low_pending = 0u;
    return;
  }
  if (!pir_board_seen)
  {
    pir_board_seen = 1u;
    pir_started_at = now;
    pir_active = pir_low_pending = 0u;
  }
  if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_4) == GPIO_PIN_SET)
  {
    pir_active = 1u;
    pir_low_pending = 0u;
  }
  else
  {
    if (!pir_low_pending) { pir_low_pending = 1u; pir_low_at = now; }
    if (now - pir_low_at >= PV_PIR_CLEAR_MS) pir_active = 0u;
  }
}
uint8_t PV_PirStatus(uint32_t now)
{
  uint16_t raw;
  if (!pir_board_seen || now - pir_polled_at > 1000u || !PV_TemperatureRead(now, &raw)) return PV_PIR_UNAVAILABLE;
  return now - pir_started_at < PV_PIR_WARMUP_MS ? PV_PIR_WARMING : PV_PIR_OK;
}
uint32_t PV_PirWarmupRemaining(uint32_t now)
{
  return PV_PirStatus(now) == PV_PIR_WARMING ? (PV_PIR_WARMUP_MS - (now - pir_started_at) + 999u) / 1000u : 0u;
}
int PV_PirRead(uint32_t now, uint8_t *detected)
{
  if (PV_PirStatus(now) != PV_PIR_OK) return 0;
  *detected = pir_active;
  return 1;
}
void PV_SensorsPoll(uint32_t now)
{
  uint8_t bytes[3], command = 0xF3u;
  HAL_StatusTypeDef result;
  rain_poll(now);
  pir_poll(now);
  if (valid && now - last_good > 2000u) { valid = 0u; status = PV_TEMP_TIMEOUT; }
  if (!ready) { status = PV_TEMP_TIMEOUT; return; }
  if (pending && now - started_at >= 100u)
  {
    pending = 0u;
    result = HAL_I2C_Master_Receive(&sensor_i2c, 0x80u, bytes, 3u, 3u);
    valid = 0u;
    if (result != HAL_OK) status = result == HAL_TIMEOUT ? PV_TEMP_TIMEOUT : PV_TEMP_MISSING;
    else if (!PV_ShtDecode(bytes, &temperature_raw)) status = PV_TEMP_CRC;
    else { last_good = now; valid = 1u; status = PV_TEMP_OK; }
  }
  if (!pending && now - started_at >= 1000u)
  {
    started_at = now;
    /* No-hold conversion: the 100 ms measurement wait never blocks the main loop. */
    result = HAL_I2C_Master_Transmit(&sensor_i2c, 0x80u, &command, 1u, 3u);
    if (result == HAL_OK) pending = 1u;
    else { valid = 0u; status = result == HAL_TIMEOUT ? PV_TEMP_TIMEOUT : PV_TEMP_MISSING; }
  }
}
int PV_TemperatureRead(uint32_t now, uint16_t *raw)
{
  if (!valid || now - last_good > 2000u) return 0;
  *raw = temperature_raw;
  return 1;
}
uint8_t PV_TemperatureStatus(void) { return status; }
