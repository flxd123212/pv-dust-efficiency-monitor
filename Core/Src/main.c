/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"
#include "gpio.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include <stdio.h>
#include <string.h>
#include "cnfont.h"
#include "pv_app.h"
#include "pv_io.h"
#include "pv_store.h"
/* USER CODE END Includes */

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/

/* USER CODE BEGIN PV */

/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
/* USER CODE BEGIN PFP */
static void LCD_Pins(void);
static void LCD_Init(void);
static void LCD_Rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t c);
static void LCD_Text(uint16_t x, uint16_t y, const char *s, uint16_t fg, uint16_t bg, uint8_t sc);
static void LCD_TextR(uint16_t xr, uint16_t y, const char *s, uint16_t fg, uint16_t bg, uint8_t sc);
static void DrawCN(uint16_t x, uint16_t y, uint8_t idx, uint16_t fg, uint16_t bg, uint8_t sc);
static void CN2(uint16_t x, uint16_t y, uint8_t a, uint8_t b, uint16_t fg, uint16_t bg);
static void ADC_Init(void);
static uint16_t ADC_Read(uint8_t ch);
static void TP_Init(void);
static uint8_t TP_Read(uint16_t *x, uint16_t *y);
static void Servo_Init(void);
static void Servo_Set(uint16_t deg);
static void App_Local(const char *action, uint32_t value);
static void UI_Rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t c);
static void UI_Page(uint8_t p);
static void UI_Values(void);
/* USER CODE END PFP */

/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
#define P_DC    GPIO_PIN_0
#define LCD_Port GPIOI
#define RST_Pin  GPIO_PIN_2
#define RST_Port GPIOE
#define BL_Pin   GPIO_PIN_5
#define BL_Port  GPIOE

#define SCR_W 240
#define SCR_H 320

#define SERVO_TIMER_HZ   1000000u
#define SERVO_PERIOD_US  20000u
#define SERVO_MIN_US     500u
#define SERVO_MAX_US     1500u
#define SERVO_MAX_DEG    90u

#define C_BG     0xF7BE
#define C_CARD   0xFFFF
#define C_LINE   0xDEFB
#define C_ACC    0x04B3
#define C_TEXT   0x2104
#define C_DIM    0x7BEF
#define C_VAL    0x1082
#define C_WARN   0xD9C0
#define C_OK     0x04A9

#define cur_mA   pv.current
#define tmp_c    pv.temperature
#define rain_pct pv.rain
#define dust_pct pv.dust
#define tilt_deg pv.angle

static uint8_t  page = 0;
static uint32_t t_ui = 0, t_key = 0, t_tp = 0;
static uint8_t tp_hit = 0;
static uint8_t report_due = 1u, ui_dirty = 1u;
static const char *local_status = "READY";
static uint32_t local_status_at;
static char telemetry[PV_TELEMETRY_CAPACITY];

/* 自绘 5x7 字体 */
static const char font_chars[] = " -%./0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ";
static const uint8_t font_data[] = {
  0x00,0x00,0x00,0x00,0x00,0x00,0x00, /* space */
  0x00,0x00,0x00,0x1F,0x00,0x00,0x00, /* - */
  0x19,0x1A,0x02,0x04,0x08,0x0B,0x13, /* % */
  0x00,0x00,0x00,0x00,0x00,0x0C,0x0C, /* . */
  0x01,0x02,0x02,0x04,0x08,0x08,0x10, /* / */
  0x0E,0x11,0x13,0x15,0x19,0x11,0x0E, /* 0 */
  0x04,0x0C,0x04,0x04,0x04,0x04,0x0E, /* 1 */
  0x0E,0x11,0x01,0x02,0x04,0x08,0x1F, /* 2 */
  0x1F,0x02,0x04,0x02,0x01,0x11,0x0E, /* 3 */
  0x02,0x06,0x0A,0x12,0x1F,0x02,0x02, /* 4 */
  0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E, /* 5 */
  0x06,0x08,0x10,0x1E,0x11,0x11,0x0E, /* 6 */
  0x1F,0x01,0x02,0x04,0x08,0x08,0x08, /* 7 */
  0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E, /* 8 */
  0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C, /* 9 */
  0x00,0x0C,0x0C,0x00,0x0C,0x0C,0x00, /* : */
  0x0E,0x11,0x11,0x1F,0x11,0x11,0x11, /* A */
  0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E, /* B */
  0x0E,0x11,0x10,0x10,0x10,0x11,0x0E, /* C */
  0x1C,0x12,0x11,0x11,0x11,0x12,0x1C, /* D */
  0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F, /* E */
  0x1F,0x10,0x10,0x1E,0x10,0x10,0x10, /* F */
  0x0E,0x11,0x10,0x17,0x11,0x11,0x0F, /* G */
  0x11,0x11,0x11,0x1F,0x11,0x11,0x11, /* H */
  0x0E,0x04,0x04,0x04,0x04,0x04,0x0E, /* I */
  0x07,0x02,0x02,0x02,0x02,0x12,0x0C, /* J */
  0x11,0x12,0x14,0x18,0x14,0x12,0x11, /* K */
  0x10,0x10,0x10,0x10,0x10,0x10,0x1F, /* L */
  0x11,0x1B,0x15,0x15,0x11,0x11,0x11, /* M */
  0x11,0x19,0x15,0x13,0x11,0x11,0x11, /* N */
  0x0E,0x11,0x11,0x11,0x11,0x11,0x0E, /* O */
  0x1E,0x11,0x11,0x1E,0x10,0x10,0x10, /* P */
  0x0E,0x11,0x11,0x11,0x15,0x12,0x0D, /* Q */
  0x1E,0x11,0x11,0x1E,0x14,0x12,0x11, /* R */
  0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E, /* S */
  0x1F,0x04,0x04,0x04,0x04,0x04,0x04, /* T */
  0x11,0x11,0x11,0x11,0x11,0x11,0x0E, /* U */
  0x11,0x11,0x11,0x11,0x11,0x0A,0x04, /* V */
  0x11,0x11,0x11,0x15,0x15,0x1B,0x11, /* W */
  0x11,0x11,0x0A,0x04,0x0A,0x11,0x11, /* X */
  0x11,0x11,0x0A,0x04,0x04,0x04,0x04, /* Y */
  0x1F,0x01,0x02,0x04,0x08,0x10,0x1F, /* Z */
};
/* USER CODE END 0 */

/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */

  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  /* USER CODE BEGIN 2 */
  {
    GPIO_InitTypeDef key = {0};
    key.Pin = GPIO_PIN_5;
    key.Mode = GPIO_MODE_INPUT;
    key.Pull = GPIO_PULLUP;
    HAL_GPIO_Init(GPIOC, &key);
  }
  LCD_Pins();
  LCD_Init();
  ADC_Init();
  PV_SensorsInit();
  TP_Init();
  {
    PV_Settings settings;
    int loaded = PV_StoreRead(&settings);
    PV_Init(HAL_GetTick(), loaded ? &settings : 0);
  }
  Servo_Init();
  PV_IOInit();
  UI_Page(0);
  IWDG->KR = 0x5555u;
  IWDG->PR = 4u;
  IWDG->RLR = 4095u;
  IWDG->KR = 0xAAAAu;
  IWDG->KR = 0xCCCCu;
/* USER CODE END 2 */

  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
    uint32_t now = HAL_GetTick();
    uint16_t tx, ty;
    static uint8_t touching = 0u, swiped = 0u;
    static uint16_t x0 = 0u, y0 = 0u, pwm_angle = PV_STOW_ANGLE;
    static uint32_t t0 = 0u, t_sample = 0u, t_report = 0u, commands = 0u;

    IWDG->KR = 0xAAAAu;
    PV_IOPoll(now);
    now = HAL_GetTick();
    PV_SensorsPoll(now);
    now = HAL_GetTick();
    if (now - t_sample >= 250u)
    {
      uint32_t sum_current = 0u, sum_voltage = 0u, sum_ntc = 0u;
      uint16_t temperature_raw = 0u;
      uint8_t i, adc_ok = 1u, ntc_ok = 1u, flags = 0u, rain = 0u, person = 0u, pir_status;
      t_sample = now;
      for (i = 0u; i < 8u; i++)
      {
        uint16_t a = ADC_Read(8u), b = ADC_Read(9u);
        uint16_t c = ADC_Read(5u);
        if (a == 0xFFFFu || b == 0xFFFFu) { adc_ok = 0u; break; }
        sum_current += a;
        sum_voltage += b;
        if (c == 0xFFFFu) ntc_ok = 0u; else sum_ntc += c;
      }
      if (PV_TemperatureRead(HAL_GetTick(), &temperature_raw))
      {
        flags |= PV_VALID_TEMP;
        if (adc_ok) flags |= PV_VALID_CURRENT;
      }
      if (PV_RainRead(HAL_GetTick(), &rain)) flags |= PV_VALID_RAIN;
      PV_Sample((uint16_t)(sum_current / 8u), temperature_raw,
        rain, flags, HAL_GetTick());
      pv.adc_voltage = (uint16_t)(sum_voltage / 8u);
      pv.temperature_status = PV_TemperatureStatus();
      PV_NtcSample(adc_ok && ntc_ok ? (uint16_t)(sum_ntc / 8u) : 0xFFFFu, HAL_GetTick());
      now = HAL_GetTick();
      pir_status = PV_PirStatus(now);
      (void)PV_PirRead(now, &person);
      PV_PirSample(pir_status, person, PV_PirWarmupRemaining(now), now);
    }
    now = HAL_GetTick();
    PV_Tick(now);
    if (pwm_angle != pv.angle) { pwm_angle = pv.angle; Servo_Set(pwm_angle); }
    HAL_GPIO_WritePin(GPIOC, GPIO_PIN_6, pv.cleaning ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_15, PV_AlarmAudible(now) ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(LED1_GPIO_Port, LED1_Pin, PV_LedOn(now) ? GPIO_PIN_SET : GPIO_PIN_RESET);
    if (commands != PV_IOCommands()) { commands = PV_IOCommands(); report_due = ui_dirty = 1u; }
    if (report_due || now - t_report >= 1000u)
    {
      report_due = 0u;
      t_report = now;
      if (PV_Telemetry(telemetry, sizeof(telemetry), now)) PV_IOData(telemetry);
    }

    if (now - t_key >= 20u)
    {
      static uint8_t k1p = 1u, k3p = 1u, held = 0u;
      static uint32_t pressed_at = 0u;
      uint8_t k1 = (HAL_GPIO_ReadPin(GPIOF, GPIO_PIN_9) == GPIO_PIN_RESET ||
                     HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_9) == GPIO_PIN_RESET) ? 0u : 1u;
      uint8_t k3 = HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_5) == GPIO_PIN_RESET ? 0u : 1u;
      t_key = now;
      if (!k1 && k1p) UI_Page((uint8_t)((page + 1u) % 3u));
      if (!k3 && k3p) { pressed_at = now; held = 0u; }
      if (!k3 && !held && now - pressed_at >= 1000u) { held = 1u; App_Local("stop", 1u); UI_Page(1u); }
      if (k3 && !k3p && !held) { App_Local("angle", pv.target <= 85u ? pv.target + 5u : 90u); UI_Page(1u); }
      k1p = k1;
      k3p = k3;
    }

    if (now - t_tp >= 25u)
    {
      t_tp = now;
      tp_hit = TP_Read(&tx, &ty);
      if (tp_hit)
      {
        if (!touching) { touching = 1u; swiped = 0u; x0 = tx; y0 = ty; t0 = now; }
        else if (!swiped && (tx > x0 + 70u || tx + 70u < x0))
        {
          swiped = 1u;
          UI_Page((uint8_t)((page + (tx > x0 ? 2u : 1u)) % 3u));
        }
      }
      else if (touching)
      {
        touching = 0u;
        if (!swiped && now - t0 < 700u)
        {
          if (y0 < 40u) UI_Page((uint8_t)(x0 / 80u));
          else if (page == 1u)
          {
            if (x0 < 120u && y0 > 74u && y0 < 132u) App_Local("clean", pv.cleaning ? 0u : 1u);
            else if (x0 >= 120u && y0 > 74u && y0 < 132u) App_Local("angle", pv.target <= 85u ? pv.target + 5u : 90u);
            else if (x0 < 120u && y0 > 142u && y0 < 200u) App_Local("angle", pv.target >= 5u ? pv.target - 5u : 0u);
            else if (x0 >= 120u && y0 > 142u && y0 < 200u) App_Local(PV_LocalStopAction(), 1u);
            else if (y0 > 238u && y0 < 276u)
            {
              if (pv.motion_paused) App_Local("resume", 1u);
              else App_Local("mode", pv.automatic ? 0u : 1u);
            }
          }
          else if (page == 2u && y0 > 238u && y0 < 276u) App_Local("save", 1u);
        }
      }
    }
    if (now - t_ui >= 250u) { t_ui = now; UI_Values(); }
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Configure the main internal regulator output voltage
  */
  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

  /** Initializes the RCC Oscillators according to the specified parameters
  * in the RCC_OscInitTypeDef structure.
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_NONE;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_HSI;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_0) != HAL_OK)
  {
    Error_Handler();
  }
}

/* USER CODE BEGIN 4 */
static void LCD_Pins(void)
{
  GPIO_InitTypeDef g;
  __HAL_RCC_GPIOI_CLK_ENABLE();
  __HAL_RCC_GPIOE_CLK_ENABLE();
  __HAL_RCC_SPI2_CLK_ENABLE();

  g.Mode = GPIO_MODE_AF_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  g.Alternate = GPIO_AF5_SPI2;
  g.Pin = GPIO_PIN_1 | GPIO_PIN_3;
  HAL_GPIO_Init(GPIOI, &g);

  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Alternate = 0;
  g.Pin = GPIO_PIN_0;
  HAL_GPIO_Init(GPIOI, &g);

  g.Pin = RST_Pin | BL_Pin;
  HAL_GPIO_Init(GPIOE, &g);

  SPI2->CR1 = 0;
  SPI2->CR2 = 0u;
  SPI2->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_SPE;

  HAL_GPIO_WritePin(LCD_Port, P_DC, GPIO_PIN_SET);
  HAL_GPIO_WritePin(BL_Port, BL_Pin, GPIO_PIN_SET);
}

static void spi8(uint8_t b)
{
  while (!(SPI2->SR & SPI_SR_TXE)) { }
  *(volatile uint8_t *)&SPI2->DR = b;
}

static void spi_flush(void) { while (SPI2->SR & SPI_SR_BSY) { } }
static void wcmd(uint8_t c) { spi_flush(); HAL_GPIO_WritePin(LCD_Port, P_DC, GPIO_PIN_RESET); spi8(c); spi_flush(); HAL_GPIO_WritePin(LCD_Port, P_DC, GPIO_PIN_SET); }
static void wdat(uint8_t d) { spi8(d); }

static void LCD_Init(void)
{
  HAL_GPIO_WritePin(RST_Port, RST_Pin, GPIO_PIN_SET);   HAL_Delay(1);
  HAL_GPIO_WritePin(RST_Port, RST_Pin, GPIO_PIN_RESET); HAL_Delay(80);
  HAL_GPIO_WritePin(RST_Port, RST_Pin, GPIO_PIN_SET);   HAL_Delay(120);

  wcmd(0x01); HAL_Delay(120);
  wcmd(0xCF); wdat(0x00); wdat(0xC1); wdat(0x30);
  wcmd(0xED); wdat(0x64); wdat(0x03); wdat(0x12); wdat(0x81);
  wcmd(0xE8); wdat(0x85); wdat(0x00); wdat(0x78);
  wcmd(0xCB); wdat(0x39); wdat(0x2C); wdat(0x00); wdat(0x34); wdat(0x02);
  wcmd(0xF7); wdat(0x20);
  wcmd(0xEA); wdat(0x00); wdat(0x00);
  wcmd(0xC0); wdat(0x23);
  wcmd(0xC1); wdat(0x10);
  wcmd(0xC5); wdat(0x3E); wdat(0x28);
  wcmd(0xC7); wdat(0x86);
  wcmd(0x36); wdat(0x08);
  wcmd(0x37); wdat(0x00);
  wcmd(0x3A); wdat(0x55);
  wcmd(0xB1); wdat(0x00); wdat(0x18);
  wcmd(0xB6); wdat(0x08); wdat(0x82); wdat(0x27);
  wcmd(0xF2); wdat(0x00);
  wcmd(0x26); wdat(0x01);
  wcmd(0xE0); wdat(0x0F); wdat(0x31); wdat(0x2B); wdat(0x0C); wdat(0x0E);
              wdat(0x08); wdat(0x4E); wdat(0xF1); wdat(0x37); wdat(0x07);
              wdat(0x10); wdat(0x03); wdat(0x0E); wdat(0x09); wdat(0x00);
  wcmd(0xE1); wdat(0x00); wdat(0x0E); wdat(0x14); wdat(0x03); wdat(0x11);
              wdat(0x07); wdat(0x31); wdat(0xC1); wdat(0x48); wdat(0x08);
              wdat(0x0F); wdat(0x0C); wdat(0x31); wdat(0x36); wdat(0x0F);
  wcmd(0x11); HAL_Delay(120);
  wcmd(0x21);
  wcmd(0x29); HAL_Delay(50);
  spi_flush();
}

static void LCD_Win(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1)
{
  wcmd(0x2A); wdat((uint8_t)(x0 >> 8)); wdat((uint8_t)x0);
              wdat((uint8_t)(x1 >> 8)); wdat((uint8_t)x1);
  wcmd(0x2B); wdat((uint8_t)(y0 >> 8)); wdat((uint8_t)y0);
              wdat((uint8_t)(y1 >> 8)); wdat((uint8_t)y1);
  wcmd(0x2C);
}

static void LCD_Rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t c)
{
  uint32_t i, n;
  if (!w || !h) return;
  n = (uint32_t)w * h;
  LCD_Win(x, y, (uint16_t)(x + w - 1), (uint16_t)(y + h - 1));
  for (i = 0; i < n; i++) { wdat((uint8_t)(c >> 8)); wdat((uint8_t)c); }
}

/* 5x7 ASCII：因本屏文字流镜像，做“字形+位置”双重补偿 */
static void LCD_Char(uint16_t x, uint16_t y, char ch, uint16_t fg, uint16_t bg, uint8_t sc)
{
  const char *p = strchr(font_chars, ch);
  uint8_t row, col, line;
  if (p == 0) p = font_chars;
  for (row = 0; row < 7; row++)
  {
    line = font_data[(uint16_t)(p - font_chars) * 7 + row];
    for (col = 0; col < 5; col++)
    {
      LCD_Rect((uint16_t)(x + col * sc), (uint16_t)(y + row * sc), sc, sc,
               (line & (1 << col)) ? fg : bg);
    }
    LCD_Rect((uint16_t)(x + 5 * sc), (uint16_t)(y + row * sc), sc, sc, bg);
  }
}

static void LCD_Text(uint16_t x, uint16_t y, const char *s, uint16_t fg, uint16_t bg, uint8_t sc)
{
  uint16_t len = (uint16_t)strlen(s);
  uint16_t w   = (uint16_t)(len * 6 * sc);
  uint16_t xs  = (uint16_t)(SCR_W - x - w);
  uint16_t i;

  for (i = 0; i < len; i++)
  {
    LCD_Char((uint16_t)(xs + (len - 1 - i) * 6 * sc), y, s[i], fg, bg, sc);
  }
}

static void LCD_TextR(uint16_t xr, uint16_t y, const char *s, uint16_t fg, uint16_t bg, uint8_t sc)
{
  uint16_t w = (uint16_t)(strlen(s) * 6 * sc);
  LCD_Text((uint16_t)(xr - w), y, s, fg, bg, sc);
}

static void DrawCN(uint16_t x, uint16_t y, uint8_t idx, uint16_t fg, uint16_t bg, uint8_t sc)
{
  uint16_t xs, row, col, run;
  uint8_t ink;

  if (idx >= CN_NUM) return;
  xs = (uint16_t)(SCR_W - x - 16 * sc);

  for (row = 0; row < 16; row++)
  {
    uint16_t bits = (uint16_t)(((uint16_t)cn_data[idx * 32 + row * 2] << 8) |
                                cn_data[idx * 32 + row * 2 + 1]);
    col = 0;
    while (col < 16)
    {
      ink = (bits & (1u << col)) ? 1 : 0;
      run = 1;
      while ((col + run) < 16 && (((bits & (1u << (col + run))) ? 1 : 0) == ink)) run++;
      LCD_Rect((uint16_t)(xs + col * sc), (uint16_t)(y + row * sc),
               (uint16_t)(run * sc), sc, ink ? fg : bg);
      col = (uint16_t)(col + run);
    }
  }
}

static void CN2(uint16_t x, uint16_t y, uint8_t a, uint8_t b, uint16_t fg, uint16_t bg)
{
  DrawCN(x, y, a, fg, bg, 1);
  DrawCN((uint16_t)(x + 17), y, b, fg, bg, 1);
}

static void Servo_Init(void)
{
  GPIO_InitTypeDef g = {0};
  uint32_t timer_hz = HAL_RCC_GetPCLK1Freq();

  /* F407 APB timers run at twice PCLK when the APB prescaler is not 1. */
  if ((RCC->CFGR & RCC_CFGR_PPRE1) != RCC_CFGR_PPRE1_DIV1) timer_hz *= 2u;
  if (timer_hz < SERVO_TIMER_HZ || (timer_hz % SERVO_TIMER_HZ) != 0u)
  {
    Error_Handler();
    return;
  }

  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_TIM3_CLK_ENABLE();
  __HAL_RCC_TIM3_FORCE_RESET();
  __HAL_RCC_TIM3_RELEASE_RESET();

  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Alternate = 0;

  g.Pin = GPIO_PIN_6 | GPIO_PIN_7 | GPIO_PIN_8;
  HAL_GPIO_WritePin(GPIOC, g.Pin, GPIO_PIN_RESET);
  HAL_GPIO_Init(GPIOC, &g);

  g.Pin = GPIO_PIN_15;
  HAL_GPIO_WritePin(GPIOA, g.Pin, GPIO_PIN_RESET);
  HAL_GPIO_Init(GPIOA, &g);

  /* PC8 = AF2 / TIM3_CH3. Preload applies angle changes at frame boundaries. */
  TIM3->CR1 = TIM_CR1_ARPE;
  TIM3->PSC = timer_hz / SERVO_TIMER_HZ - 1u;
  TIM3->ARR = SERVO_PERIOD_US - 1u;
  TIM3->CCMR2 = TIM_CCMR2_OC3M_1 | TIM_CCMR2_OC3M_2 | TIM_CCMR2_OC3PE;
  Servo_Set(tilt_deg);
  TIM3->EGR = TIM_EGR_UG;
  TIM3->SR = 0;

  /* Start low, then generate a complete first pulse after the counter wraps. */
  TIM3->CNT = TIM3->ARR;
  TIM3->CCER = TIM_CCER_CC3E;
  g.Pin = GPIO_PIN_8;
  g.Mode = GPIO_MODE_AF_PP;
  g.Alternate = GPIO_AF2_TIM3;
  HAL_GPIO_Init(GPIOC, &g);
  TIM3->CR1 |= TIM_CR1_CEN;
}

static void Servo_Set(uint16_t deg)
{
  if (deg > SERVO_MAX_DEG) deg = SERVO_MAX_DEG;
  TIM3->CCR3 = SERVO_MIN_US + ((SERVO_MAX_US - SERVO_MIN_US) * deg) / SERVO_MAX_DEG;
}

static void App_Local(const char *action, uint32_t value)
{
  local_status = PV_Apply(action, value, HAL_GetTick());
  local_status_at = HAL_GetTick();
  report_due = ui_dirty = 1u;
}

static void ADC_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_ADC1_CLK_ENABLE();

  g.Pin = GPIO_PIN_0 | GPIO_PIN_1;
  g.Mode = GPIO_MODE_ANALOG;
  g.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOB, &g);
  g.Pin = GPIO_PIN_5;
  HAL_GPIO_Init(GPIOA, &g);

  ADC->CCR = (ADC->CCR & ~ADC_CCR_ADCPRE) | ADC_CCR_ADCPRE_0;
  ADC1->CR1 = 0;
  ADC1->CR2 = ADC_CR2_ADON;
  ADC1->SMPR2 = (7u << 15) | (7u << 24) | (7u << 27);
  HAL_Delay(5);
}

static uint16_t ADC_Read(uint8_t ch)
{
  uint32_t started = HAL_GetTick();
  ADC1->SQR1 = 0;
  ADC1->SQR3 = ch;
  ADC1->CR2 |= ADC_CR2_SWSTART;
  while (!(ADC1->SR & ADC_SR_EOC))
  {
    if (HAL_GetTick() - started > 5u) return 0xFFFFu;
  }
  return (uint16_t)(ADC1->DR & 0x0FFF);
}

static void tp_dly(void) { volatile uint8_t i; for (i = 0; i < 25; i++) { __NOP(); } }
#define SCL_H() HAL_GPIO_WritePin(GPIOH, GPIO_PIN_4, GPIO_PIN_SET)
#define SCL_L() HAL_GPIO_WritePin(GPIOH, GPIO_PIN_4, GPIO_PIN_RESET)
#define SDA_H() HAL_GPIO_WritePin(GPIOH, GPIO_PIN_5, GPIO_PIN_SET)
#define SDA_L() HAL_GPIO_WritePin(GPIOH, GPIO_PIN_5, GPIO_PIN_RESET)
#define SDA_R() HAL_GPIO_ReadPin(GPIOH, GPIO_PIN_5)

static void TP_Init(void)
{
  GPIO_InitTypeDef g;
  __HAL_RCC_GPIOH_CLK_ENABLE();
  g.Pin = GPIO_PIN_4 | GPIO_PIN_5;
  g.Mode = GPIO_MODE_OUTPUT_OD;
  g.Pull = GPIO_PULLUP;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOH, &g);
  SDA_H(); SCL_H();
}

static void i2c_start(void) { SDA_H(); SCL_H(); tp_dly(); SDA_L(); tp_dly(); SCL_L(); tp_dly(); }
static void i2c_stop(void)  { SDA_L(); tp_dly(); SCL_H(); tp_dly(); SDA_H(); tp_dly(); }

static uint8_t i2c_wb(uint8_t b)
{
  uint8_t i, ack;
  for (i = 0; i < 8; i++)
  {
    if (b & 0x80) { SDA_H(); } else { SDA_L(); }
    b = (uint8_t)(b << 1);
    tp_dly(); SCL_H(); tp_dly(); SCL_L(); tp_dly();
  }
  SDA_H(); tp_dly(); SCL_H(); tp_dly();
  ack = (SDA_R() == GPIO_PIN_RESET) ? 1 : 0;
  SCL_L(); tp_dly();
  return ack;
}

static uint8_t i2c_rb(uint8_t ack)
{
  uint8_t i, v = 0;
  SDA_H();
  for (i = 0; i < 8; i++)
  {
    v = (uint8_t)(v << 1);
    SCL_H(); tp_dly();
    if (SDA_R() == GPIO_PIN_SET) v |= 1;
    SCL_L(); tp_dly();
  }
  if (ack) { SDA_L(); } else { SDA_H(); }
  tp_dly(); SCL_H(); tp_dly(); SCL_L(); tp_dly(); SDA_H();
  return v;
}

static uint8_t tp_rd(uint8_t reg, uint8_t *buf, uint8_t n)
{
  uint8_t i;
  i2c_start();
  if (!i2c_wb(0x70)) { i2c_stop(); return 0; }
  if (!i2c_wb(reg))  { i2c_stop(); return 0; }
  i2c_start();
  if (!i2c_wb(0x71)) { i2c_stop(); return 0; }
  for (i = 0; i < n; i++) { buf[i] = i2c_rb((uint8_t)(i + 1 < n)); }
  i2c_stop();
  return 1;
}

static uint8_t TP_Read(uint16_t *x, uint16_t *y)
{
  uint8_t st, b[4];
  uint16_t rx, ry;

  if (!tp_rd(0x02, &st, 1)) return 0;
  if ((st & 0x0F) == 0) return 0;
  if (!tp_rd(0x03, b, 4)) return 0;

  rx = (uint16_t)(((b[0] & 0x0F) << 8) | b[1]);
  ry = (uint16_t)(((b[2] & 0x0F) << 8) | b[3]);

  *x = (rx < SCR_W) ? rx : (SCR_W - 1);
  *y = (ry < SCR_H) ? ry : (SCR_H - 1);
  return 1;
}

static void UI_Rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t c)
{
  LCD_Rect((uint16_t)(SCR_W - x - w), y, w, h, c);
}

static void UI_Header(void)
{
  static const uint8_t tab[3][2] = {{CN_SHU, CN_JU}, {CN_KONG, CN_ZHI}, {CN_XIN, CN_XI}};
  uint8_t i;

  UI_Rect(0, 0, SCR_W, 38, C_CARD);
  for (i = 0; i < 3; i++)
  {
    CN2((uint16_t)(i * 80 + 24), 10, tab[i][0], tab[i][1],
        (i == page) ? C_ACC : C_DIM, C_CARD);
    if (i == page) UI_Rect((uint16_t)(i * 80 + 8), 30, 64, 3, C_ACC);
  }
  UI_Rect(0, 38, SCR_W, 1, C_LINE);
}

static void UI_Page(uint8_t p)
{
  page = (uint8_t)(p % 3u);
  UI_Rect(0, 39, SCR_W, 281, C_BG);
  UI_Header();
  if (page == 0u)
  {
    CN2(14, 48, CN_GUANG, CN_FU, C_TEXT, C_BG);
    CN2(48, 48, CN_JIAN, CN_CE, C_ACC, C_BG);
    CN2(14, 78, CN_DIAN, CN_LIU, C_TEXT, C_BG);
    UI_Rect(14, 106, 212, 1, C_LINE);
    LCD_Text(14, 122, "ENV/SHT20", C_TEXT, C_BG, 1);
    LCD_Text(14, 154, "PANEL/NTC~", C_TEXT, C_BG, 1);
    CN2(14, 186, CN_YU, CN_DI, C_TEXT, C_BG);
    CN2(14, 218, CN_JI, CN_HUI, C_TEXT, C_BG);
    CN2(14, 250, CN_QING, CN_JIAO, C_TEXT, C_BG);
  }
  else if (page == 1u)
  {
    CN2(14, 48, CN_KONG, CN_ZHI, C_ACC, C_BG);
    UI_Rect(12, 74, 104, 58, C_CARD);
    UI_Rect(124, 74, 104, 58, C_CARD);
    UI_Rect(12, 142, 104, 58, C_CARD);
    UI_Rect(124, 142, 104, 58, C_CARD);
    CN2(142, 94, CN_SHENG, CN_GAO, C_TEXT, C_CARD);
    CN2(30, 162, CN_JIANG, CN_DI2, C_TEXT, C_CARD);
  }
  else
  {
    LCD_Text(14, 52, "PV MONITOR V3", C_ACC, C_BG, 2);
    LCD_Text(14, 82, "STM32F407  PC8 PWM", C_TEXT, C_BG, 1);
    LCD_Text(14, 100, "STLINK UART6 115200", C_TEXT, C_BG, 1);
    UI_Rect(14, 120, 212, 1, C_LINE);
    UI_Rect(12, 238, 216, 38, C_CARD);
    LCD_Text(72, 252, "SAVE SETTINGS", C_ACC, C_CARD, 1);
  }
  UI_Rect(0, 292, SCR_W, 28, C_CARD);
  ui_dirty = 1u;
  UI_Values();
}

static void UI_Values(void)
{
  static PV_State shown;
  static uint32_t second = 0xFFFFFFFFu;
  char buf[36];
  uint32_t now = HAL_GetTick(), seconds = now / 1000u;
  uint8_t dirty = ui_dirty;
  ui_dirty = 0u;
  if (page == 0u)
  {
    if (dirty || shown.current != pv.current || shown.valid_flags != pv.valid_flags)
    {
      UI_Rect(90, 74, 138, 25, C_BG);
      if (pv.valid_flags & PV_VALID_CURRENT) sprintf(buf, "%4u mA", cur_mA); else strcpy(buf, "  -- mA");
      LCD_TextR(226, 74, buf, C_ACC, C_BG, 3);
    }
    if (dirty || shown.temperature != pv.temperature || shown.valid_flags != pv.valid_flags)
    {
      UI_Rect(110, 118, 118, 20, C_BG);
      if (pv.valid_flags & PV_VALID_TEMP)
      {
        unsigned int magnitude = (unsigned int)(tmp_c < 0 ? -tmp_c : tmp_c);
        sprintf(buf, "%s%u.%u C", tmp_c < 0 ? "-" : "", magnitude / 10u, magnitude % 10u);
      }
      else strcpy(buf, " -- C");
      LCD_TextR(226, 118, buf, C_VAL, C_BG, 2);
    }
    if (dirty || shown.rain != pv.rain || shown.valid_flags != pv.valid_flags)
    {
      UI_Rect(110, 184, 118, 20, C_BG);
      LCD_TextR(226, 184, !(pv.valid_flags & PV_VALID_RAIN) ? "--" : rain_pct ? "RAIN" : "DRY", rain_pct ? C_WARN : C_DIM, C_BG, 2);
    }
    if (dirty || shown.ntc_valid != pv.ntc_valid || shown.surface_temperature != pv.surface_temperature)
    {
      UI_Rect(110, 150, 118, 20, C_BG);
      if (pv.ntc_valid) sprintf(buf, "~%u.%u C", (unsigned int)pv.surface_temperature / 10u, (unsigned int)pv.surface_temperature % 10u);
      else strcpy(buf, " -- C");
      LCD_TextR(226, 150, buf, pv.ntc_valid ? C_VAL : C_WARN, C_BG, 2);
    }
    if (dirty || shown.dust != pv.dust || shown.cfg.baseline_ma != pv.cfg.baseline_ma || shown.valid_flags != pv.valid_flags)
    {
      UI_Rect(110, 216, 118, 20, C_BG);
      if (pv.cfg.baseline_ma >= 50u && pv.current >= 50u && pv.sensor_ok) sprintf(buf, "%3u %%", dust_pct); else strcpy(buf, " -- %");
      LCD_TextR(226, 216, buf, (pv.alarm & 1u) ? C_WARN : C_VAL, C_BG, 2);
    }
    if (dirty || shown.angle != pv.angle)
    {
      UI_Rect(110, 248, 118, 20, C_BG);
      sprintf(buf, "%3u deg", tilt_deg);
      LCD_TextR(226, 248, buf, C_VAL, C_BG, 2);
    }
  }
  else if (page == 1u)
  {
    if (dirty || shown.motion_paused != pv.motion_paused)
    {
      UI_Rect(124, 142, 104, 58, C_CARD);
      if (pv.motion_paused) LCD_Text(158, 166, "RESUME", C_ACC, C_CARD, 1);
      else CN2(142, 162, CN_TING, CN_ZHI2, C_WARN, C_CARD);
    }
    if (dirty || shown.cleaning != pv.cleaning)
    {
      uint16_t bg = pv.cleaning ? 0xDFF5 : C_CARD;
      UI_Rect(12, 74, 104, 58, bg);
      UI_Rect(12, 74, 3, 58, C_OK);
      CN2(30, 94, pv.cleaning ? CN_TING : CN_QINGJIE, pv.cleaning ? CN_ZHI2 : CN_JIE, C_TEXT, bg);
    }
    if (dirty || shown.angle != pv.angle || shown.target != pv.target)
    {
      UI_Rect(14, 210, 212, 12, C_BG);
      sprintf(buf, "ANGLE %u > %u DEG", pv.angle, pv.target);
      LCD_Text(14, 212, buf, C_TEXT, C_BG, 1);
    }
    if (dirty || shown.rain_state != pv.rain_state || shown.motion_paused != pv.motion_paused ||
        shown.valid_flags != pv.valid_flags || second != seconds)
    {
      size_t i;
      UI_Rect(14, 226, 212, 10, C_BG);
      if (now - local_status_at < 5000u && strcmp(local_status, "OK") && strcmp(local_status, "READY"))
      {
        for (i = 0u; i < sizeof(buf) - 1u && local_status[i]; i++) buf[i] = local_status[i] == '_' ? ' ' : local_status[i];
        buf[i] = 0;
      }
      else if (pv.motion_paused) strcpy(buf, "STOPPED - TAP RESUME");
      else if (!(pv.valid_flags & PV_VALID_RAIN)) strcpy(buf, "RAIN INPUT UNAVAILABLE");
      else if (pv.rain_state == PV_RAIN_WET) strcpy(buf, "RAIN SHIELD 90 DEG");
      else if (pv.rain_state == PV_RAIN_DRYING) sprintf(buf, "DRY CONFIRM %lu S", (unsigned long)PV_RainDryRemaining(now));
      else if (pv.rain_state == PV_RAIN_RETURNING) strcpy(buf, "STOWING TO 0 DEG");
      else
      {
        for (i = 0u; i < sizeof(buf) - 1u && local_status[i]; i++) buf[i] = local_status[i] == '_' ? ' ' : local_status[i];
        buf[i] = 0;
      }
      LCD_Text(14, 228, buf, !strcmp(local_status, "OK") || !strcmp(local_status, "READY") ? C_OK : C_WARN, C_BG, 1);
    }
    if (dirty || shown.automatic != pv.automatic || shown.motion_paused != pv.motion_paused)
    {
      UI_Rect(12, 238, 216, 38, C_CARD);
      sprintf(buf, "MODE  %s", pv.motion_paused ? "RESUME" : pv.automatic ? "AUTO" : "MANUAL");
      LCD_Text(68, 252, buf, C_ACC, C_CARD, 1);
    }
  }
  else if (dirty || second != seconds)
  {
    UI_Rect(14, 132, 212, 94, C_BG);
    sprintf(buf, "UP %lu:%02lu:%02lu", (unsigned long)(seconds / 3600u), (unsigned long)(seconds / 60u % 60u), (unsigned long)(seconds % 60u));
    LCD_Text(14, 134, buf, C_TEXT, C_BG, 1);
    sprintf(buf, "BASE %lu mA", (unsigned long)pv.cfg.baseline_ma);
    LCD_Text(14, 154, buf, C_TEXT, C_BG, 1);
    sprintf(buf, "ADC I/V %u/%u N %u", pv.adc_current, pv.adc_voltage, pv.ntc_adc);
    LCD_Text(14, 174, buf, C_DIM, C_BG, 1);
    sprintf(buf, "UART ERR %lu", (unsigned long)PV_IOErrors());
    LCD_Text(14, 194, buf, C_DIM, C_BG, 1);
    LCD_Text(14, 214, pv.saved ? "SETTINGS SAVED" : "SETTINGS UNSAVED", pv.saved ? C_OK : C_WARN, C_BG, 1);
  }
  if (dirty || shown.pir_status != pv.pir_status || shown.person_detected != pv.person_detected ||
      shown.pir_warmup_s != pv.pir_warmup_s || shown.pir_alarm_enabled != pv.pir_alarm_enabled)
  {
    UI_Rect(14, 280, 212, 9, C_BG);
    if (pv.pir_status == PV_PIR_WARMING) sprintf(buf, "PIR WARMUP %u S", pv.pir_warmup_s);
    else if (pv.pir_status != PV_PIR_OK) strcpy(buf, "PIR UNAVAILABLE");
    else strcpy(buf, pv.person_detected ? "PIR MOTION DETECTED" : "PIR NO MOTION");
    if (!pv.pir_alarm_enabled) strcat(buf, " - ALARM OFF");
    LCD_Text(14, 280, buf, pv.pir_status != PV_PIR_OK || pv.person_detected ? C_WARN : C_DIM, C_BG, 1);
  }
  if (dirty || shown.automatic != pv.automatic || shown.cleaning != pv.cleaning || shown.alarm != pv.alarm)
  {
    UI_Rect(0, 292, SCR_W, 28, C_CARD);
    sprintf(buf, "%s  CLEAN %s", pv.automatic ? "AUTO" : "MANUAL", pv.cleaning ? "ON" : "OFF");
    LCD_Text(10, 302, buf, C_TEXT, C_CARD, 1);
    LCD_TextR(230, 302, pv.alarm ? "ALARM" : "NORMAL", pv.alarm ? C_WARN : C_OK, C_CARD, 1);
  }
  shown = pv;
  second = seconds;
}
/* USER CODE END 4 */

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}
#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
