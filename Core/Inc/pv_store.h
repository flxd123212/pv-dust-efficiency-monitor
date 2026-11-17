#ifndef PV_STORE_H
#define PV_STORE_H
#include "pv_app.h"
#define PV_STORE_VERSION 3u
typedef struct {
  uint32_t magic, version, sequence;
  PV_Settings cfg;
  uint32_t crc, reserved[6], committed;
} PV_Record;
uint32_t PV_Crc32(const void *data, size_t length);
int PV_RecordValid(const PV_Record *record);
int PV_StoreRead(PV_Settings *settings);
#endif
