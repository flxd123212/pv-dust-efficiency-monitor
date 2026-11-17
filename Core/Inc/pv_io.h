#ifndef PV_IO_H
#define PV_IO_H
#include <stdint.h>
void PV_IOInit(void);
void PV_IOPoll(uint32_t now);
void PV_IOData(const char *line);
uint32_t PV_IOErrors(void);
uint32_t PV_IOCommands(void);
#endif
