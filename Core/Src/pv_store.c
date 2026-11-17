#include "main.h"
#include "pv_store.h"
#include <string.h>

#define STORE_A 0x080C0000u
#define STORE_B 0x080E0000u
#define STORE_SIZE 0x20000u
static const PV_Record *latest;

int PV_StoreRead(PV_Settings *settings)
{
  uint32_t address;
  latest = 0;
  for (address = STORE_A; address < STORE_B + STORE_SIZE; address += sizeof(PV_Record))
  {
    const PV_Record *record = (const PV_Record *)address;
    if (PV_RecordValid(record) && (!latest || (int32_t)(record->sequence - latest->sequence) > 0)) latest = record;
  }
  if (!latest) return 0;
  *settings = latest->cfg;
  return 1;
}

int PV_StoreWrite(const PV_Settings *settings)
{
  PV_Record record;
  FLASH_EraseInitTypeDef erase;
  uint32_t address, base, i, sector_error;
  HAL_StatusTypeDef status = HAL_OK;
  int empty;
  if (!PV_SettingsValid(settings)) return 0;
  memset(&record, 0xFF, sizeof(record));
  record.magic = 0x50565332u;
  record.version = PV_STORE_VERSION;
  record.sequence = latest ? latest->sequence + 1u : 1u;
  record.cfg = *settings;
  record.crc = PV_Crc32(&record, offsetof(PV_Record, crc));
  record.committed = 0x434F4D54u;
  base = latest && (uint32_t)latest >= STORE_B ? STORE_B : STORE_A;
  address = latest ? (uint32_t)latest + sizeof(PV_Record) : base;
  while (address < base + STORE_SIZE)
  {
    empty = 1;
    for (i = 0u; i < sizeof(PV_Record); i += 4u)
      if (*(const uint32_t *)(address + i) != 0xFFFFFFFFu) { empty = 0; break; }
    if (empty) break;
    address += sizeof(PV_Record);
  }
  if (HAL_FLASH_Unlock() != HAL_OK) return 0;
  __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_EOP | FLASH_FLAG_OPERR | FLASH_FLAG_WRPERR | FLASH_FLAG_PGAERR | FLASH_FLAG_PGPERR | FLASH_FLAG_PGSERR);
  if (address >= base + STORE_SIZE)
  {
    /* Erase the other journal only; the last committed settings stay intact. */
    base = base == STORE_A ? STORE_B : STORE_A;
    memset(&erase, 0, sizeof(erase));
    erase.TypeErase = FLASH_TYPEERASE_SECTORS;
    erase.Sector = base == STORE_A ? FLASH_SECTOR_10 : FLASH_SECTOR_11;
    erase.NbSectors = 1u;
    erase.VoltageRange = FLASH_VOLTAGE_RANGE_3;
    status = HAL_FLASHEx_Erase(&erase, &sector_error);
    address = base;
  }
  for (i = 0u; status == HAL_OK && i < sizeof(PV_Record); i += 4u)
  {
    uint32_t word;
    memcpy(&word, (const uint8_t *)&record + i, sizeof(word));
    if (word != 0xFFFFFFFFu) status = HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, address + i, word);
  }
  (void)HAL_FLASH_Lock();
  if (status != HAL_OK || !PV_RecordValid((const PV_Record *)address)) return 0;
  latest = (const PV_Record *)address;
  return 1;
}
