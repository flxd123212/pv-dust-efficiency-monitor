#include "main.h"
#include "pv_io.h"
#include "pv_app.h"
#include <string.h>

#define RX_SIZE 1024u
#define TX_SIZE 2048u
#define PORT_COUNT 3u
typedef struct {
  USART_TypeDef *uart;
  volatile uint16_t rx_head, rx_tail, tx_head, tx_tail;
  volatile uint32_t faults;
  uint32_t seen_faults;
  uint16_t used;
  uint8_t dropping;
  char rx[RX_SIZE], tx[TX_SIZE], line[512];
} Serial;
static Serial ports[PORT_COUNT];
static char ack[192];
static uint32_t commands;

static void irq(Serial *s)
{
  uint32_t status = s->uart->SR;
  if (status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE | USART_SR_NE))
  {
    char ch = (char)s->uart->DR;
    uint16_t next = (uint16_t)((s->rx_head + 1u) & (RX_SIZE - 1u));
    if (status & (USART_SR_ORE | USART_SR_FE | USART_SR_NE)) s->faults++;
    else if (next == s->rx_tail) s->faults++;
    else { s->rx[s->rx_head] = ch; __DMB(); s->rx_head = next; }
  }
  if ((status & USART_SR_TXE) && (s->uart->CR1 & USART_CR1_TXEIE))
  {
    if (s->tx_tail == s->tx_head) s->uart->CR1 &= ~USART_CR1_TXEIE;
    else
    {
      s->uart->DR = (uint8_t)s->tx[s->tx_tail];
      s->tx_tail = (uint16_t)((s->tx_tail + 1u) & (TX_SIZE - 1u));
    }
  }
}
void USART1_IRQHandler(void) { irq(&ports[0]); }
void USART3_IRQHandler(void) { irq(&ports[1]); }
void USART6_IRQHandler(void) { irq(&ports[2]); }

static int enqueue(Serial *s, const char *line, unsigned int reserve)
{
  size_t n = strlen(line), i;
  uint16_t head = s->tx_head;
  uint32_t available = (s->tx_tail - head - 1u) & (TX_SIZE - 1u);
  uint32_t primask;
  if (n + reserve > available) return 0;
  for (i = 0; i < n; i++) { s->tx[head] = line[i]; head = (uint16_t)((head + 1u) & (TX_SIZE - 1u)); }
  __DMB();
  primask = __get_PRIMASK();
  __disable_irq();
  s->tx_head = head;
  s->uart->CR1 |= USART_CR1_TXEIE;
  __set_PRIMASK(primask);
  return 1;
}

void PV_IOInit(void)
{
  GPIO_InitTypeDef g = {0};
  unsigned int p;
  memset(ports, 0, sizeof(ports));
  commands = 0u;
  ports[0].uart = USART1;
  ports[1].uart = USART3;
  ports[2].uart = USART6;
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOG_CLK_ENABLE();
  __HAL_RCC_USART1_CLK_ENABLE();
  __HAL_RCC_USART3_CLK_ENABLE();
  __HAL_RCC_USART6_CLK_ENABLE();
  g.Mode = GPIO_MODE_AF_PP;
  g.Pull = GPIO_PULLUP;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  g.Pin = GPIO_PIN_9 | GPIO_PIN_10;
  g.Alternate = GPIO_AF7_USART1;
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin = GPIO_PIN_10 | GPIO_PIN_11;
  g.Alternate = GPIO_AF7_USART3;
  HAL_GPIO_Init(GPIOB, &g);
  /* The existing ST-Link ribbon carries USART6, not the baseboard CH340. */
  g.Pin = GPIO_PIN_9 | GPIO_PIN_14;
  g.Alternate = GPIO_AF8_USART6;
  HAL_GPIO_Init(GPIOG, &g);
  for (p = 0u; p < PORT_COUNT; p++)
  {
    ports[p].uart->CR1 = 0u;
    ports[p].uart->CR2 = 0u;
    ports[p].uart->CR3 = 0u;
  }
  USART1->BRR = (HAL_RCC_GetPCLK2Freq() + 57600u) / 115200u;
  USART3->BRR = (HAL_RCC_GetPCLK1Freq() + 57600u) / 115200u;
  USART6->BRR = (HAL_RCC_GetPCLK2Freq() + 57600u) / 115200u;
  for (p = 0u; p < PORT_COUNT; p++)
    ports[p].uart->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_UE;
  HAL_NVIC_SetPriority(USART1_IRQn, 5u, 0u);
  HAL_NVIC_SetPriority(USART3_IRQn, 5u, 0u);
  HAL_NVIC_SetPriority(USART6_IRQn, 5u, 0u);
  HAL_NVIC_EnableIRQ(USART1_IRQn);
  HAL_NVIC_EnableIRQ(USART3_IRQn);
  HAL_NVIC_EnableIRQ(USART6_IRQn);
}

void PV_IOPoll(uint32_t now)
{
  unsigned int p, budget;
  for (p = 0u; p < PORT_COUNT; p++)
  {
    Serial *s = &ports[p];
    if (s->faults != s->seen_faults) { s->used = 0u; s->dropping = 1u; s->seen_faults = s->faults; }
    for (budget = 0u; budget < 256u && s->rx_tail != s->rx_head; budget++)
    {
      char ch = s->rx[s->rx_tail];
      s->rx_tail = (uint16_t)((s->rx_tail + 1u) & (RX_SIZE - 1u));
      if (ch == '\n')
      {
        if (!s->dropping && s->used)
        {
          s->line[s->used] = 0;
          if (PV_Command(s->line, ack, sizeof(ack), now)) { (void)enqueue(s, ack, 0u); commands++; }
        }
        s->used = 0u;
        s->dropping = 0u;
      }
      else if (ch != '\r' && !s->dropping)
      {
        if ((unsigned char)ch < 32u || s->used >= sizeof(s->line) - 1u) { s->used = 0u; s->dropping = 1u; }
        else s->line[s->used++] = ch;
      }
    }
  }
}
void PV_IOData(const char *line)
{
  unsigned int p;
  for (p = 0u; p < PORT_COUNT; p++) (void)enqueue(&ports[p], line, sizeof(ack));
}
uint32_t PV_IOErrors(void)
{
  unsigned int p;
  uint32_t errors = 0u;
  for (p = 0u; p < PORT_COUNT; p++) errors += ports[p].faults;
  return errors;
}
uint32_t PV_IOCommands(void) { return commands; }
