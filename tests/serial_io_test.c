#include "main.h"
#include "pv_io.h"
#include "pv_app.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

USART_TypeDef mock_uarts[3];
GPIO_TypeDef mock_gpios[3] = {{0u}, {1u}, {2u}};
uint32_t mock_clocks, mock_primask;
static GPIO_InitTypeDef gpio_configs[3];
static unsigned int gpio_calls, parsed;
static uint8_t enabled[128], priorities[128];
static uint32_t pclk1, pclk2;
static char last_line[512];

void USART1_IRQHandler(void);
void USART3_IRQHandler(void);
void USART6_IRQHandler(void);
static void (*const handlers[3])(void) = {
  USART1_IRQHandler, USART3_IRQHandler, USART6_IRQHandler
};

void HAL_GPIO_Init(GPIO_TypeDef *gpio, GPIO_InitTypeDef *config)
{
  assert(gpio->id < 3u);
  gpio_configs[gpio->id] = *config;
  gpio_calls++;
}
uint32_t HAL_RCC_GetPCLK1Freq(void) { return pclk1; }
uint32_t HAL_RCC_GetPCLK2Freq(void) { return pclk2; }
void HAL_NVIC_SetPriority(int irq, uint32_t preemption, uint32_t subpriority)
{
  assert(irq >= 0 && irq < 128 && preemption == 5u && subpriority == 0u);
  priorities[irq] = 1u;
}
void HAL_NVIC_EnableIRQ(int irq)
{
  assert(irq >= 0 && irq < 128);
  enabled[irq] = 1u;
}
int PV_Command(const char *json, char *ack, size_t capacity, uint32_t now)
{
  assert(now == 123u && strlen(json) < sizeof(last_line));
  strcpy(last_line, json);
  parsed++;
  assert(capacity >= 5u);
  strcpy(ack, "ACK\n");
  return 1;
}
static void reset(uint32_t bus1, uint32_t bus2)
{
  memset(mock_uarts, 0, sizeof(mock_uarts));
  memset(gpio_configs, 0, sizeof(gpio_configs));
  memset(enabled, 0, sizeof(enabled));
  memset(priorities, 0, sizeof(priorities));
  mock_clocks = mock_primask = gpio_calls = parsed = 0u;
  pclk1 = bus1;
  pclk2 = bus2;
  PV_IOInit();
}
static void rx_byte(unsigned int p, unsigned char ch, uint32_t errors)
{
  mock_uarts[p].DR = ch;
  mock_uarts[p].SR = USART_SR_RXNE | errors;
  handlers[p]();
  mock_uarts[p].SR = 0u;
}
static void receive(unsigned int p, const char *line)
{
  while (*line) rx_byte(p, (unsigned char)*line++, 0u);
}
static size_t drain(unsigned int p, char *output, size_t capacity)
{
  size_t used = 0u;
  while (mock_uarts[p].CR1 & USART_CR1_TXEIE)
  {
    assert(used + 1u < capacity);
    mock_uarts[p].DR = UINT32_MAX;
    mock_uarts[p].SR = USART_SR_TXE;
    handlers[p]();
    if (mock_uarts[p].DR != UINT32_MAX) output[used++] = (char)mock_uarts[p].DR;
  }
  mock_uarts[p].SR = 0u;
  output[used] = 0;
  return used;
}
static void test_init(void)
{
  unsigned int p;
  reset(42000000u, 84000000u);
  assert(mock_clocks == 63u && gpio_calls == 3u);
  assert(gpio_configs[0].Pin == (GPIO_PIN_9 | GPIO_PIN_10));
  assert(gpio_configs[1].Pin == (GPIO_PIN_10 | GPIO_PIN_11));
  assert(gpio_configs[2].Pin == (GPIO_PIN_9 | GPIO_PIN_14));
  assert(gpio_configs[0].Alternate == 7u && gpio_configs[1].Alternate == 7u);
  assert(gpio_configs[2].Alternate == GPIO_AF8_USART6);
  assert(USART1->BRR == 729u && USART3->BRR == 365u && USART6->BRR == 729u);
  assert(enabled[USART1_IRQn] && enabled[USART3_IRQn] && enabled[USART6_IRQn]);
  assert(priorities[USART1_IRQn] && priorities[USART3_IRQn] && priorities[USART6_IRQn]);
  for (p = 0u; p < 3u; p++)
  {
    assert(gpio_configs[p].Mode == GPIO_MODE_AF_PP);
    assert(gpio_configs[p].Pull == GPIO_PULLUP);
    assert(mock_uarts[p].CR1 == (USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_UE));
    assert(mock_uarts[p].CR2 == 0u && mock_uarts[p].CR3 == 0u);
  }
  reset(16000000u, 16000000u);
  assert(USART1->BRR == 139u && USART3->BRR == 139u && USART6->BRR == 139u);
}
static void test_routes(void)
{
  char output[128];
  unsigned int p, other;
  reset(16000000u, 16000000u);
  mock_primask = 1u;
  PV_IOData("{\"type\":\"data\"}\n");
  assert(mock_primask == 1u);
  for (p = 0u; p < 3u; p++)
  {
    drain(p, output, sizeof(output));
    assert(!strcmp(output, "{\"type\":\"data\"}\n"));
  }
  mock_primask = 0u;
  for (p = 0u; p < 3u; p++)
  {
    receive(p, "command\r\n");
    PV_IOPoll(123u);
    assert(!strcmp(last_line, "command") && parsed == p + 1u);
    for (other = 0u; other < 3u; other++)
    {
      drain(other, output, sizeof(output));
      assert(!strcmp(output, other == p ? "ACK\n" : ""));
    }
  }
  assert(PV_IOCommands() == 3u && PV_IOErrors() == 0u && mock_primask == 0u);
}
static void test_recovery(void)
{
  unsigned int i;
  char output[128];
  reset(16000000u, 16000000u);
  receive(2u, "partial");
  PV_IOPoll(123u);
  assert(parsed == 0u);
  rx_byte(2u, 'x', USART_SR_ORE);
  PV_IOPoll(123u);
  receive(2u, "discard\nvalid\n");
  PV_IOPoll(123u);
  assert(PV_IOErrors() == 1u && parsed == 1u && !strcmp(last_line, "valid"));
  drain(2u, output, sizeof(output));
  assert(!strcmp(output, "ACK\n"));
  for (i = 0u; i < 600u; i++) rx_byte(2u, 'x', 0u);
  PV_IOPoll(123u);
  PV_IOPoll(123u);
  PV_IOPoll(123u);
  receive(2u, "\nvalid\n");
  PV_IOPoll(123u);
  assert(parsed == 2u);
  drain(2u, output, sizeof(output));
  assert(!strcmp(output, "ACK\n"));
  for (i = 0u; i < 1100u; i++) rx_byte(2u, 'x', 0u);
  for (i = 0u; i < 5u; i++) PV_IOPoll(123u);
  receive(2u, "\nvalid\n");
  PV_IOPoll(123u);
  assert(PV_IOErrors() > 1u && parsed == 3u);
  drain(2u, output, sizeof(output));
  assert(!strcmp(output, "ACK\n"));
}
static void test_ack_reserve(void)
{
  char first[1501], second[401], output[2048];
  size_t used;
  reset(16000000u, 16000000u);
  memset(first, 'x', sizeof(first) - 1u);
  first[sizeof(first) - 1u] = 0;
  memset(second, 'y', sizeof(second) - 1u);
  second[sizeof(second) - 1u] = 0;
  PV_IOData(first);
  PV_IOData(second);
  receive(2u, "command\n");
  PV_IOPoll(123u);
  used = drain(2u, output, sizeof(output));
  assert(used == 1504u && !memcmp(output, first, 1500u));
  assert(!strcmp(output + 1500u, "ACK\n"));
}
int main(void)
{
  test_init();
  test_routes();
  test_recovery();
  test_ack_reserve();
  puts("Serial IO tests passed (USART1/3/6, ST-Link PG9/PG14, ACK routing, recovery).");
  return 0;
}
