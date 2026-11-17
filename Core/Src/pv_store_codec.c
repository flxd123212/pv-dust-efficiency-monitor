#include "pv_store.h"
#include <stddef.h>
uint32_t PV_Crc32(const void *data, size_t length)
{
  const uint8_t *bytes = (const uint8_t *)data;
  uint32_t crc = 0xFFFFFFFFu;
  size_t i;
  unsigned int bit;
  for (i = 0u; i < length; i++)
  {
    crc ^= bytes[i];
    for (bit = 0u; bit < 8u; bit++) crc = (crc >> 1) ^ ((crc & 1u) ? 0xEDB88320u : 0u);
  }
  return ~crc;
}
int PV_RecordValid(const PV_Record *r)
{
  return r->magic == 0x50565332u && r->version == PV_STORE_VERSION && r->committed == 0x434F4D54u &&
    PV_SettingsValid(&r->cfg) && r->crc == PV_Crc32(r, offsetof(PV_Record, crc));
}
