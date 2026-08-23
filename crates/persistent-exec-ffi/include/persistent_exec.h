#ifndef PERSISTENT_EXEC_H
#define PERSISTENT_EXEC_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PersistentExecResult {
  bool success;
  uint32_t error_code;
  char *error;
  void *handle;
  char *data;
  int64_t int_value;
} PersistentExecResult;

PersistentExecResult *persistent_exec_create(void);
void persistent_exec_destroy(void *handle);
PersistentExecResult *persistent_exec_spawn(void *handle, const char *request_json);
PersistentExecResult *persistent_exec_write(void *handle, const char *request_json);
PersistentExecResult *persistent_exec_poll(void *handle, const char *request_json);
PersistentExecResult *persistent_exec_terminate(void *handle, const char *request_json);
void persistent_exec_free_result(PersistentExecResult *result);

#ifdef __cplusplus
}
#endif

#endif
