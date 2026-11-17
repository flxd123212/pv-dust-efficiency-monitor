#include "main.h"
#include "pv_sensors.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

GPIO_TypeDef mock_gpios[3] = {{0u}, {1u}, {2u}};
uint32_t mock_clocks, mock_i2c;
static uint32_t tick, sent, received;
static HAL_StatusTypeDef tx_result = HAL_OK, rx_result = HAL_OK;
static uint8_t packet[3] = {0x66u, 0x64u, 0x70u};
static GPIO_PinState rain_level = GPIO_PIN_SET;
static unsigned int rain_configured;
static GPIO_PinState pir_level = GPIO_PIN_RESET;
static unsigned int pir_configured;

uint32_t HAL_GetTick(void) { return tick; }
void HAL_GPIO_Init(GPIO_TypeDef *gpio, GPIO_InitTypeDef *config)
{
  if (gpio == GPIOA)
  {
    assert(config->Pin == GPIO_PIN_4 && config->Mode == GPIO_MODE_INPUT);
    assert(config->Pull == GPIO_PULLDOWN);
    rain_configured++;
    return;
  }
  if (gpio == GPIOB && config->Pin == GPIO_PIN_4)
  {
    assert(config->Mode == GPIO_MODE_INPUT && config->Pull == GPIO_PULLUP);
    pir_configured++;
    return;
  }
  assert(gpio == GPIOB && config->Pin == (GPIO_PIN_6 | GPIO_PIN_7));
  assert(config->Mode == GPIO_MODE_AF_OD && config->Alternate == GPIO_AF4_I2C1);
  assert(config->Pull == GPIO_PULLUP);
}
GPIO_PinState HAL_GPIO_ReadPin(GPIO_TypeDef *gpio, uint16_t pin)
{
  if (gpio == GPIOB && pin == GPIO_PIN_4) return pir_level;
  assert(gpio == GPIOA && pin == GPIO_PIN_4);
  return rain_level;
}
HAL_StatusTypeDef HAL_I2C_Init(I2C_HandleTypeDef *handle)
{
  assert(handle->Instance == I2C1 && handle->Init.ClockSpeed == 100000u);
  assert(handle->Init.AddressingMode == I2C_ADDRESSINGMODE_7BIT);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_I2C_Master_Transmit(I2C_HandleTypeDef *handle, uint16_t address, uint8_t *bytes, uint16_t count, uint32_t timeout)
{
  assert(handle->Instance == I2C1 && address == 0x80u && count == 1u && timeout <= 3u);
  assert(bytes[0] == 0xF3u);
  sent++;
  return tx_result;
}
HAL_StatusTypeDef HAL_I2C_Master_Receive(I2C_HandleTypeDef *handle, uint16_t address, uint8_t *bytes, uint16_t count, uint32_t timeout)
{
  assert(handle->Instance == I2C1 && address == 0x80u && count == 3u && timeout <= 3u);
  received++;
  memcpy(bytes, packet, 3u);
  return rx_result;
}
static void pir_tests(void)
{
  uint32_t t, start;
  uint8_t detected = 9u;
  tick = 0u;
  PV_SensorsInit();
  assert(pir_configured && PV_PirStatus(0u) == PV_PIR_UNAVAILABLE);
  PV_SensorsPoll(0u); PV_SensorsPoll(100u); PV_SensorsPoll(101u);
  assert(PV_PirStatus(101u) == PV_PIR_WARMING && PV_PirWarmupRemaining(101u) == 60u);
  assert(!PV_PirRead(101u, &detected) && detected == 9u);
  for (t = 201u; t < 60101u; t += 100u) PV_SensorsPoll(t);
  assert(PV_PirStatus(60100u) == PV_PIR_WARMING && PV_PirWarmupRemaining(60100u) == 1u);
  PV_SensorsPoll(60101u);
  assert(PV_PirRead(60101u, &detected) && !detected);
  pir_level = GPIO_PIN_SET; PV_SensorsPoll(60102u);
  assert(PV_PirRead(60102u, &detected) && detected);
  pir_level = GPIO_PIN_RESET; PV_SensorsPoll(60103u);
  for (t = 60203u; t < 65103u; t += 100u) PV_SensorsPoll(t);
  assert(PV_PirRead(65102u, &detected) && detected);
  PV_SensorsPoll(65103u);
  assert(PV_PirRead(65103u, &detected) && !detected);
  pir_level = GPIO_PIN_SET; PV_SensorsPoll(65104u);
  pir_level = GPIO_PIN_RESET; PV_SensorsPoll(65105u);
  pir_level = GPIO_PIN_SET; PV_SensorsPoll(65205u);
  pir_level = GPIO_PIN_RESET; PV_SensorsPoll(65206u);
  for (t = 65306u; t < 70206u; t += 100u) PV_SensorsPoll(t);
  assert(PV_PirRead(70205u, &detected) && detected);
  PV_SensorsPoll(70206u);
  assert(PV_PirRead(70206u, &detected) && !detected);
  tx_result = HAL_ERROR;
  for (t = 70306u; t <= 72306u; t += 100u) PV_SensorsPoll(t);
  assert(PV_PirStatus(72306u) == PV_PIR_UNAVAILABLE && !PV_PirRead(72306u, &detected));
  tx_result = HAL_OK;
  for (t = 72406u; t <= 74806u; t += 100u) PV_SensorsPoll(t);
  assert(PV_PirStatus(74806u) == PV_PIR_WARMING);
  assert(PV_PirStatus(75807u) == PV_PIR_UNAVAILABLE);
  PV_SensorsPoll(75807u); PV_SensorsPoll(75907u); PV_SensorsPoll(76007u);
  assert(PV_PirStatus(76007u) == PV_PIR_WARMING && PV_PirWarmupRemaining(76007u) >= 59u);
  start = UINT32_MAX - 1000u; tick = start;
  PV_SensorsInit();
  for (t = 0u; t <= 60100u; t += 100u) PV_SensorsPoll(start + t);
  assert(PV_PirStatus(start + 60199u) == PV_PIR_WARMING);
  PV_SensorsPoll(start + 60200u);
  assert(PV_PirStatus(start + 60200u) == PV_PIR_OK);
  puts("PIR IO tests passed (PB4 pull-up, real board gate, 60s warmup, immediate motion, 5s clear, reassert, stale/reconnect/wraparound).");
}
int main(void)
{
  uint16_t raw = 0u;
  uint8_t rain = 9u;
  uint8_t negative[3] = {0x40u, 0u, 0x89u};
  uint8_t humidity[3] = {0x68u, 0x3Au, 0x7Cu};
  assert(PV_ShtDecode(packet, &raw) && raw == 0x6664u);
  assert(PV_TemperatureDeci(raw) == 234);
  assert(PV_ShtDecode(negative, &raw) && PV_TemperatureDeci(raw) == -29);
  assert(!PV_ShtDecode(humidity, &raw));
  PV_SensorsInit();
  assert(mock_clocks == 67u && rain_configured == 1u);
  assert(!PV_RainRead(0u, &rain));
  assert(!PV_TemperatureRead(0u, &raw));
  PV_SensorsPoll(0u); PV_SensorsPoll(99u);
  assert(sent == 1u && received == 0u);
  PV_SensorsPoll(100u);
  assert(received == 1u && PV_TemperatureRead(100u, &raw));
  assert(raw == 0x6664u && PV_TemperatureStatus() == PV_TEMP_OK);
  tx_result = HAL_ERROR;
  PV_SensorsPoll(1000u);
  assert(!PV_TemperatureRead(1000u, &raw) && PV_TemperatureStatus() == PV_TEMP_MISSING);
  tx_result = HAL_OK;
  PV_SensorsPoll(2000u); PV_SensorsPoll(2100u);
  assert(PV_TemperatureRead(2100u, &raw));
  packet[2] ^= 1u;
  PV_SensorsPoll(3000u); PV_SensorsPoll(3100u);
  assert(!PV_TemperatureRead(3100u, &raw) && PV_TemperatureStatus() == PV_TEMP_CRC);
  packet[2] ^= 1u;
  rx_result = HAL_TIMEOUT;
  PV_SensorsPoll(4000u); PV_SensorsPoll(4100u);
  assert(!PV_TemperatureRead(4100u, &raw) && PV_TemperatureStatus() == PV_TEMP_TIMEOUT);
  rx_result = HAL_OK;
  PV_SensorsPoll(5000u); PV_SensorsPoll(5100u);
  assert(PV_TemperatureRead(5100u, &raw) && !PV_TemperatureRead(7101u, &raw));
  tick = UINT32_MAX - 50u;
  PV_SensorsInit(); PV_SensorsPoll(tick); PV_SensorsPoll(49u);
  assert(PV_TemperatureRead(49u, &raw));
  assert(!PV_RainRead(49u, &rain));
  PV_SensorsPoll(449u);
  assert(PV_RainRead(449u, &rain) && rain == 0u);
  rain_level = GPIO_PIN_RESET;
  PV_SensorsPoll(450u);
  assert(PV_RainRead(450u, &rain) && rain == 1u);
  rain_level = GPIO_PIN_SET;
  PV_SensorsPoll(500u); PV_SensorsPoll(999u);
  assert(PV_RainRead(999u, &rain) && rain == 1u);
  rain_level = GPIO_PIN_RESET;
  PV_SensorsPoll(1000u);
  rain_level = GPIO_PIN_SET;
  PV_SensorsPoll(1001u); PV_SensorsPoll(1500u);
  assert(PV_RainRead(1500u, &rain) && rain == 1u);
  PV_SensorsPoll(1501u);
  assert(PV_RainRead(1501u, &rain) && rain == 0u);
  assert(!PV_RainRead(2502u, &rain));
  PV_SensorsPoll(2502u);
  assert(!PV_RainRead(2502u, &rain));
  PV_SensorsPoll(3001u);
  assert(!PV_RainRead(3001u, &rain));
  PV_SensorsPoll(3002u);
  assert(PV_RainRead(3002u, &rain) && rain == 0u);
  /* Disconnected DO is pulled low: protect as rain, not a proven dry state. */
  rain_level = GPIO_PIN_RESET;
  PV_SensorsPoll(3100u);
  assert(PV_RainRead(3100u, &rain) && rain == 1u);
  assert(!PV_RainRead(4101u, &rain));
  tick = 5000u;
  PV_SensorsInit();
  assert(!PV_RainRead(tick, &rain));
  PV_SensorsPoll(tick);
  assert(PV_RainRead(tick, &rain) && rain == 1u);
  pir_tests();
  puts("Sensor IO tests passed (real SHT20 command, CRC, negative temperature, unplug/replug, timeout, wraparound).");
  puts("Rain IO tests passed (PA4 active low, fail-safe pull-down, dry debounce, stale data, wraparound).");
  return 0;
}
