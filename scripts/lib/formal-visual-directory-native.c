#define NAPI_VERSION 8

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

#define FORMAL_RENAME_REJECTED_QUARANTINED 1
#define FORMAL_RENAME_REJECTED_UNQUARANTINED 2

static napi_value int_result(napi_env env, int value) {
  napi_value result;
  if (napi_create_int32(env, value, &result) != napi_ok) {
    napi_throw_error(env, NULL, "Unable to create native directory-operation result.");
    return NULL;
  }
  return result;
}

static int read_int32(napi_env env, napi_value value, int32_t *output) {
  if (napi_get_value_int32(env, value, output) != napi_ok) {
    napi_throw_type_error(env, NULL, "Native directory-operation descriptor/flag must be int32.");
    return 0;
  }
  return 1;
}

static char *read_entry_name(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0) {
    napi_throw_type_error(env, NULL, "Native directory-operation entry name must be non-empty.");
    return NULL;
  }
  char *name = malloc(length + 1);
  if (name == NULL) {
    napi_throw_error(env, NULL, "Unable to allocate native directory-operation entry name.");
    return NULL;
  }
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, name, length + 1, &written) != napi_ok ||
      written != length || strlen(name) != length || strchr(name, '/') != NULL ||
      strchr(name, '\\') != NULL || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    free(name);
    napi_throw_type_error(env, NULL,
                          "Native directory-operation entry name must be one safe path segment.");
    return NULL;
  }
  return name;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4) {
    napi_throw_type_error(env, NULL, "openAt expects dirfd, entry name, flags, and mode.");
    return NULL;
  }
  int32_t directory_descriptor;
  int32_t flags;
  int32_t mode;
  if (!read_int32(env, argv[0], &directory_descriptor) ||
      !read_int32(env, argv[2], &flags) || !read_int32(env, argv[3], &mode)) {
    return NULL;
  }
  char *name = read_entry_name(env, argv[1]);
  if (name == NULL) return NULL;

  int descriptor = openat(directory_descriptor, name, flags, (mode_t)mode);
  int result = descriptor >= 0 ? descriptor : -errno;
  free(name);
  return int_result(env, result);
}

static napi_value read_directory_names(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, NULL, "readDirectoryNames expects one directory descriptor.");
    return NULL;
  }
  int32_t directory_descriptor;
  if (!read_int32(env, argv[0], &directory_descriptor)) return NULL;

  int duplicated_descriptor = dup(directory_descriptor);
  if (duplicated_descriptor < 0) {
    char message[96];
    snprintf(message, sizeof(message), "Unable to duplicate directory descriptor (errno %d).",
             errno);
    napi_throw_error(env, NULL, message);
    return NULL;
  }
  DIR *directory = fdopendir(duplicated_descriptor);
  if (directory == NULL) {
    int saved_errno = errno;
    close(duplicated_descriptor);
    char message[96];
    snprintf(message, sizeof(message), "Unable to read directory descriptor (errno %d).",
             saved_errno);
    napi_throw_error(env, NULL, message);
    return NULL;
  }

  napi_value result;
  if (napi_create_array(env, &result) != napi_ok) {
    closedir(directory);
    napi_throw_error(env, NULL, "Unable to create native directory-entry array.");
    return NULL;
  }
  rewinddir(directory);
  uint32_t index = 0;
  struct dirent *entry;
  int read_errno = 0;
  for (;;) {
    /* N-API calls made for the previous entry may change errno even when they
       succeed. Reset it immediately before each readdir so EOF cannot inherit
       an unrelated runtime errno and masquerade as a directory read failure. */
    errno = 0;
    entry = readdir(directory);
    if (entry == NULL) {
      read_errno = errno;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_set_element(env, result, index, name) != napi_ok) {
      closedir(directory);
      napi_throw_error(env, NULL, "Unable to append a native directory-entry name.");
      return NULL;
    }
    index += 1;
  }
  int close_errno = 0;
  if (closedir(directory) != 0) close_errno = errno;
  int saved_errno = read_errno != 0 ? read_errno : close_errno;
  if (saved_errno != 0) {
    char message[96];
    snprintf(message, sizeof(message), "Unable to finish reading directory descriptor (errno %d).",
             saved_errno);
    napi_throw_error(env, NULL, message);
    return NULL;
  }
  return result;
}

static int same_entry_identity(const struct stat *left, const struct stat *right) {
  return (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT) && left->st_dev == right->st_dev &&
         left->st_ino == right->st_ino;
}

static int rename_at_exclusive(int directory_descriptor, const char *source,
                               const char *target) {
#if defined(__APPLE__)
  return renameatx_np(directory_descriptor, source, directory_descriptor, target,
                      RENAME_EXCL | RENAME_NOFOLLOW_ANY);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, directory_descriptor, source, directory_descriptor, target,
                      RENAME_NOREPLACE);
#else
  errno = ENOTSUP;
  return -1;
#endif
}

static int named_entry_is_absent(int directory_descriptor, const char *name) {
  struct stat ignored;
  if (fstatat(directory_descriptor, name, &ignored, AT_SYMLINK_NOFOLLOW) == 0) return 0;
  return errno == ENOENT;
}

static int quarantine_rejected_target(int directory_descriptor, const char *target,
                                      const char *quarantine) {
  if (rename_at_exclusive(directory_descriptor, target, quarantine) == 0) {
    return named_entry_is_absent(directory_descriptor, target)
               ? FORMAL_RENAME_REJECTED_QUARANTINED
               : FORMAL_RENAME_REJECTED_UNQUARANTINED;
  }
  if (errno == ENOENT && named_entry_is_absent(directory_descriptor, target)) {
    return FORMAL_RENAME_REJECTED_QUARANTINED;
  }
  return FORMAL_RENAME_REJECTED_UNQUARANTINED;
}

static napi_value rename_at_exclusive_verified(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 6) {
    napi_throw_type_error(
        env, NULL,
        "renameAtExclusiveVerified expects dirfd, source descriptor, source, target, quarantine, "
        "and an optional post-check callback.");
    return NULL;
  }
  int32_t directory_descriptor;
  int32_t source_descriptor;
  if (!read_int32(env, argv[0], &directory_descriptor) ||
      !read_int32(env, argv[1], &source_descriptor)) {
    return NULL;
  }
  char *source = read_entry_name(env, argv[2]);
  if (source == NULL) return NULL;
  char *target = read_entry_name(env, argv[3]);
  if (target == NULL) {
    free(source);
    return NULL;
  }
  char *quarantine = read_entry_name(env, argv[4]);
  if (quarantine == NULL) {
    free(source);
    free(target);
    return NULL;
  }

  struct stat opened_source;
  struct stat named_source;
  if (fstat(source_descriptor, &opened_source) != 0 ||
      fstatat(directory_descriptor, source, &named_source, AT_SYMLINK_NOFOLLOW) != 0) {
    int saved_errno = errno;
    free(source);
    free(target);
    free(quarantine);
    return int_result(env, -saved_errno);
  }
  if (!same_entry_identity(&opened_source, &named_source)) {
    free(source);
    free(target);
    free(quarantine);
    return int_result(env, -ESTALE);
  }

  napi_valuetype callback_type;
  if (napi_typeof(env, argv[5], &callback_type) != napi_ok) {
    free(source);
    free(target);
    free(quarantine);
    return NULL;
  }
  if (callback_type != napi_undefined && callback_type != napi_null) {
    if (callback_type != napi_function) {
      free(source);
      free(target);
      free(quarantine);
      napi_throw_type_error(env, NULL, "Native post-check callback must be a function or undefined.");
      return NULL;
    }
    napi_value receiver;
    napi_value callback_result;
    if (napi_get_undefined(env, &receiver) != napi_ok ||
        napi_call_function(env, receiver, argv[5], 0, NULL, &callback_result) != napi_ok) {
      free(source);
      free(target);
      free(quarantine);
      return NULL;
    }
  }

  int operation_result = rename_at_exclusive(directory_descriptor, source, target);
  int result = operation_result == 0 ? 0 : -errno;
  if (operation_result == 0) {
    struct stat named_target;
    if (fstatat(directory_descriptor, target, &named_target, AT_SYMLINK_NOFOLLOW) != 0) {
      result = quarantine_rejected_target(directory_descriptor, target, quarantine);
    } else if (!same_entry_identity(&opened_source, &named_target)) {
      result = quarantine_rejected_target(directory_descriptor, target, quarantine);
    }
  }
  free(source);
  free(target);
  free(quarantine);
  return int_result(env, result);
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
      {"readDirectoryNames", NULL, read_directory_names, NULL, NULL, NULL, napi_default, NULL},
      {"renameAtExclusiveVerified", NULL, rename_at_exclusive_verified, NULL, NULL, NULL,
       napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) {
    napi_throw_error(env, NULL, "Unable to initialize native directory operations.");
    return NULL;
  }
  return exports;
}
