#ifndef PV_IO_MOCK_MAIN_H
#define PV_IO_MOCK_MAIN_H
#include <stdint.h>

typedef struct {
  volatile uint32_t SR, DR, BRR, CR1, CR2, CR3;
} USART_TypeDef;
typedef struct { unsigned int id; } GPIO_TypeDef;
typedef struct { uint32_t Pin, Mode, Pull, Speed, Alternate; } GPIO_InitTypeDef;

extern USART_TypeDef mock_uarts[3];
extern GPIO_TypeDef mock_gpios[3];
extern uint32_t mock_clocks, mock_primask;
#define USART1 (&mock_uarts[0])
#define USART3 (&mock_uarts[1])
#define USART6 (&mock_uarts[2])
#define GPIOA (&mock_gpios[0])
#define GPIOB (&mock_gpios[1])
#define GPIOG (&mock_gpios[2])
#define USART1_IRQn 37
#define USART3_IRQn 39
#define USART6_IRQn 71
#define USART_SR_FE (1u << 1)
#define USART_SR_NE (1u << 2)
#define USART_SR_ORE (1u << 3)
#define USART_SR_RXNE (1u << 5)
#define USART_SR_TXE (1u << 7)
#define USART_CR1_RE (1u << 2)
#define USART_CR1_TE (1u << 3)
#define USART_CR1_RXNEIE (1u << 5)
#define USART_CR1_TXEIE (1u << 7)
#define USART_CR1_UE (1u << 13)
#define GPIO_PIN_9 (1u << 9)
#define GPIO_PIN_4 (1u << 4)
#define GPIO_PIN_6 (1u << 6)
#define GPIO_PIN_7 (1u << 7)
#define GPIO_PIN_10 (1u << 10)
#define GPIO_PIN_11 (1u << 11)
#define GPIO_PIN_14 (1u << 14)
#define GPIO_MODE_AF_PP 2u
#define GPIO_MODE_INPUT 0u
#define GPIO_MODE_AF_OD 18u
#define GPIO_AF4_I2C1 4u
#define GPIO_PULLUP 1u
#define GPIO_PULLDOWN 2u
typedef enum { GPIO_PIN_RESET, GPIO_PIN_SET } GPIO_PinState;
#define GPIO_SPEED_FREQ_HIGH 2u
#define GPIO_AF7_USART1 7u
#define GPIO_AF7_USART3 7u
#define GPIO_AF8_USART6 8u
#define __HAL_RCC_GPIOA_CLK_ENABLE() ((void)(mock_clocks |= 1u))
#define __HAL_RCC_GPIOB_CLK_ENABLE() ((void)(mock_clocks |= 2u))
#define __HAL_RCC_GPIOG_CLK_ENABLE() ((void)(mock_clocks |= 4u))
#define __HAL_RCC_USART1_CLK_ENABLE() ((void)(mock_clocks |= 8u))
#define __HAL_RCC_USART3_CLK_ENABLE() ((void)(mock_clocks |= 16u))
#define __HAL_RCC_USART6_CLK_ENABLE() ((void)(mock_clocks |= 32u))
#define __DMB() ((void)0)
#define __get_PRIMASK() mock_primask
#define __disable_irq() ((void)(mock_primask = 1u))
#define __set_PRIMASK(value) ((void)(mock_primask = (value)))

void HAL_GPIO_Init(GPIO_TypeDef *gpio, GPIO_InitTypeDef *config);
GPIO_PinState HAL_GPIO_ReadPin(GPIO_TypeDef *gpio, uint16_t pin);
uint32_t HAL_RCC_GetPCLK1Freq(void);
uint32_t HAL_RCC_GetPCLK2Freq(void);
void HAL_NVIC_SetPriority(int irq, uint32_t preemption, uint32_t subpriority);
void HAL_NVIC_EnableIRQ(int irq);

typedef enum { HAL_OK, HAL_ERROR, HAL_BUSY, HAL_TIMEOUT } HAL_StatusTypeDef;
typedef struct {
  uint32_t ClockSpeed, DutyCycle, OwnAddress1, AddressingMode, DualAddressMode;
  uint32_t OwnAddress2, GeneralCallMode, NoStretchMode;
} I2C_InitTypeDef;
typedef struct { void *Instance; I2C_InitTypeDef Init; } I2C_HandleTypeDef;
extern uint32_t mock_i2c;
#define I2C1 (&mock_i2c)
#define I2C_DUTYCYCLE_2 0u
#define I2C_ADDRESSINGMODE_7BIT 0x4000u
#define I2C_DUALADDRESS_DISABLE 0u
#define I2C_GENERALCALL_DISABLE 0u
#define I2C_NOSTRETCH_DISABLE 0u
#define __HAL_RCC_I2C1_CLK_ENABLE() ((void)(mock_clocks |= 64u))
uint32_t HAL_GetTick(void);
HAL_StatusTypeDef HAL_I2C_Init(I2C_HandleTypeDef *handle);
HAL_StatusTypeDef HAL_I2C_Master_Transmit(I2C_HandleTypeDef *handle, uint16_t address, uint8_t *bytes, uint16_t count, uint32_t timeout);
HAL_StatusTypeDef HAL_I2C_Master_Receive(I2C_HandleTypeDef *handle, uint16_t address, uint8_t *bytes, uint16_t count, uint32_t timeout);
#endif
