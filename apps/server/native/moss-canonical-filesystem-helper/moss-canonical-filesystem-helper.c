#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <sys/stdio.h>

#if !defined(__APPLE__)
#error "The Moss canonical filesystem helper currently supports macOS only."
#endif

#define PROTOCOL_VERSION 2U
#define REQUEST_MAGIC "MOSSFSRQ"
#define RESPONSE_MAGIC "MOSSFSRS"
#define READY_LINE "MOSS_CANONICAL_FS_HELPER_READY 2\n"

#define MAX_REQUEST_BYTES (384ULL * 1024ULL * 1024ULL)
#define MAX_STAGE_BYTES (256ULL * 1024ULL * 1024ULL)
#define MAX_STAGE_ENTRIES 10000U
#define MAX_SEGMENTS 128U
#define MAX_SEGMENT_BYTES 255U
#define MAX_RELATIVE_PATH_BYTES 4096U
#define MAX_REQUEST_ID_BYTES 128U
#define MAX_RESPONSE_MESSAGE_BYTES 512U
#define FINGERPRINT_BYTES CC_SHA256_DIGEST_LENGTH
#define FINGERPRINT_HEX_BYTES (FINGERPRINT_BYTES * 2U)
#define MAX_FINGERPRINT_ENTRIES MAX_STAGE_ENTRIES

enum action_kind {
  ACTION_CREATE = 1,
  ACTION_PUBLISH = 2,
  ACTION_REPLACE = 3,
  ACTION_REMOVE = 4
};
enum entry_kind { ENTRY_MISSING = 0, ENTRY_FILE = 1, ENTRY_DIRECTORY = 2 };
enum result_status {
  STATUS_COMMITTED = 0,
  STATUS_CONFLICT = 1,
  STATUS_RECOVERY_NEEDED = 2,
  STATUS_ERROR = 3
};
enum error_kind {
  ERROR_NONE = 0,
  ERROR_DURABILITY = 1,
  ERROR_CONCURRENT = 2,
  ERROR_SYMLINK = 3,
  ERROR_CONFLICT = 4,
  ERROR_PROTOCOL = 5,
};
enum rollback_kind {
  ROLLBACK_NONE = 0,
  ROLLBACK_RESTORED = 1,
  ROLLBACK_FAILED = 2
};

typedef struct {
  uint64_t dev;
  uint64_t ino;
} identity_t;

typedef struct {
  uint8_t kind;
  identity_t identity;
} expected_target_t;

typedef struct {
  int descriptor;
  struct stat stat_value;
  int present;
} target_capture_t;

typedef struct {
  char **items;
  uint32_t count;
} segments_t;

typedef struct {
  char *relative_path;
  uint8_t kind;
  uint8_t *content;
  size_t content_length;
} payload_entry_t;

typedef struct {
  uint8_t kind;
  uint8_t *content;
  size_t content_length;
  payload_entry_t *entries;
  uint32_t entry_count;
} payload_t;

typedef struct {
  uint8_t action;
  char *request_id;
  segments_t root_segments;
  segments_t target_segments;
  identity_t expected_workspace;
  identity_t expected_root;
  identity_t expected_parent;
  expected_target_t expected_target;
  uint8_t expected_before_fingerprint[FINGERPRINT_BYTES];
  uint8_t expected_after_fingerprint[FINGERPRINT_BYTES];
  uint8_t expected_after_kind;
  payload_t payload;
} request_t;

typedef struct {
  const uint8_t *bytes;
  size_t length;
  size_t offset;
  int failed;
} reader_t;

typedef struct {
  uint8_t code;
  int changed;
} operation_error_t;

static void set_error(operation_error_t *error, uint8_t code, int changed) {
  if (error == NULL)
    return;
  error->code = code;
  error->changed = changed;
}

static uint8_t error_for_errno(int value) {
  switch (value) {
  case ELOOP:
    return ERROR_SYMLINK;
  case EEXIST:
    return ERROR_CONFLICT;
  case ENOENT:
  case ENOTDIR:
  case ESTALE:
    return ERROR_CONCURRENT;
  case ENOTSUP:
  case EOPNOTSUPP:
  case EIO:
  case EACCES:
  case EPERM:
    return ERROR_DURABILITY;
  default:
    return ERROR_DURABILITY;
  }
}

static int write_all(int descriptor, const void *source, size_t length) {
  const uint8_t *bytes = (const uint8_t *)source;
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, bytes + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR)
        continue;
      return -1;
    }
    if (written == 0) {
      errno = EIO;
      return -1;
    }
    offset += (size_t)written;
  }
  return 0;
}

static int read_request(uint8_t **output, size_t *output_length) {
  size_t capacity = 64U * 1024U;
  size_t length = 0;
  uint8_t *bytes = (uint8_t *)malloc(capacity);
  if (bytes == NULL)
    return -1;

  for (;;) {
    if (length == capacity) {
      if (capacity >= MAX_REQUEST_BYTES) {
        free(bytes);
        errno = EOVERFLOW;
        return -1;
      }
      size_t next_capacity = capacity * 2U;
      if (next_capacity > MAX_REQUEST_BYTES)
        next_capacity = MAX_REQUEST_BYTES;
      uint8_t *expanded = (uint8_t *)realloc(bytes, next_capacity);
      if (expanded == NULL) {
        free(bytes);
        return -1;
      }
      bytes = expanded;
      capacity = next_capacity;
    }
    ssize_t read_count = read(STDIN_FILENO, bytes + length, capacity - length);
    if (read_count < 0) {
      if (errno == EINTR)
        continue;
      free(bytes);
      return -1;
    }
    if (read_count == 0)
      break;
    length += (size_t)read_count;
    if (length > MAX_REQUEST_BYTES) {
      free(bytes);
      errno = EOVERFLOW;
      return -1;
    }
  }
  *output = bytes;
  *output_length = length;
  return 0;
}

static int reader_take(reader_t *reader, void *destination, size_t length) {
  if (reader == NULL || reader->failed ||
      length > reader->length - reader->offset) {
    if (reader != NULL)
      reader->failed = 1;
    return -1;
  }
  memcpy(destination, reader->bytes + reader->offset, length);
  reader->offset += length;
  return 0;
}

static int reader_u8(reader_t *reader, uint8_t *value) {
  return reader_take(reader, value, sizeof(*value));
}

static int reader_u32(reader_t *reader, uint32_t *value) {
  uint8_t bytes[4];
  if (reader_take(reader, bytes, sizeof(bytes)) != 0)
    return -1;
  *value = ((uint32_t)bytes[0] << 24U) | ((uint32_t)bytes[1] << 16U) |
           ((uint32_t)bytes[2] << 8U) | (uint32_t)bytes[3];
  return 0;
}

static int reader_u64(reader_t *reader, uint64_t *value) {
  uint8_t bytes[8];
  if (reader_take(reader, bytes, sizeof(bytes)) != 0)
    return -1;
  *value = ((uint64_t)bytes[0] << 56U) | ((uint64_t)bytes[1] << 48U) |
           ((uint64_t)bytes[2] << 40U) | ((uint64_t)bytes[3] << 32U) |
           ((uint64_t)bytes[4] << 24U) | ((uint64_t)bytes[5] << 16U) |
           ((uint64_t)bytes[6] << 8U) | (uint64_t)bytes[7];
  return 0;
}

static int reader_bytes(reader_t *reader, uint8_t **value, size_t length) {
  uint8_t *bytes = NULL;
  if (length > 0U) {
    bytes = (uint8_t *)malloc(length);
    if (bytes == NULL)
      return -1;
    if (reader_take(reader, bytes, length) != 0) {
      free(bytes);
      return -1;
    }
  }
  *value = bytes;
  return 0;
}

static int reader_string(reader_t *reader, char **value,
                         uint32_t maximum_length) {
  uint32_t length = 0;
  if (reader_u32(reader, &length) != 0 || length == 0U ||
      length > maximum_length) {
    if (reader != NULL)
      reader->failed = 1;
    return -1;
  }
  char *string = (char *)malloc((size_t)length + 1U);
  if (string == NULL)
    return -1;
  if (reader_take(reader, string, length) != 0) {
    free(string);
    return -1;
  }
  string[length] = '\0';
  if (memchr(string, '\0', length) != NULL) {
    free(string);
    reader->failed = 1;
    return -1;
  }
  *value = string;
  return 0;
}

static int safe_segment(const char *value, size_t length) {
  if (value == NULL || length == 0U || length > MAX_SEGMENT_BYTES ||
      (length == 1U && value[0] == '.') ||
      (length == 2U && value[0] == '.' && value[1] == '.') ||
      memchr(value, '/', length) != NULL ||
      memchr(value, '\\', length) != NULL ||
      memchr(value, '\0', length) != NULL) {
    return 0;
  }
  return 1;
}

static int parse_segments(reader_t *reader, segments_t *segments) {
  uint32_t count = 0;
  if (reader_u32(reader, &count) != 0 || count > MAX_SEGMENTS) {
    if (reader != NULL)
      reader->failed = 1;
    return -1;
  }
  segments->count = count;
  segments->items = NULL;
  if (count == 0U)
    return 0;
  segments->items = (char **)calloc(count, sizeof(char *));
  if (segments->items == NULL)
    return -1;
  for (uint32_t index = 0; index < count; index += 1U) {
    if (reader_string(reader, &segments->items[index], MAX_SEGMENT_BYTES) !=
            0 ||
        !safe_segment(segments->items[index], strlen(segments->items[index]))) {
      reader->failed = 1;
      return -1;
    }
  }
  return 0;
}

static int parse_identity(reader_t *reader, identity_t *identity) {
  return reader_u64(reader, &identity->dev) ||
         reader_u64(reader, &identity->ino);
}

static int parse_payload(reader_t *reader, payload_t *payload) {
  uint8_t reserved[3];
  if (reader_u8(reader, &payload->kind) != 0 ||
      reader_take(reader, reserved, sizeof(reserved)) != 0) {
    return -1;
  }
  payload->content = NULL;
  payload->content_length = 0U;
  payload->entries = NULL;
  payload->entry_count = 0U;
  if (payload->kind == ENTRY_MISSING)
    return 0;
  if (payload->kind == ENTRY_FILE) {
    uint64_t length = 0;
    if (reader_u64(reader, &length) != 0 || length > MAX_STAGE_BYTES ||
        length > (uint64_t)(reader->length - reader->offset)) {
      reader->failed = 1;
      return -1;
    }
    payload->content_length = (size_t)length;
    return reader_bytes(reader, &payload->content, payload->content_length);
  }
  if (payload->kind != ENTRY_DIRECTORY) {
    reader->failed = 1;
    return -1;
  }
  uint32_t count = 0;
  if (reader_u32(reader, &count) != 0 || count > MAX_STAGE_ENTRIES) {
    reader->failed = 1;
    return -1;
  }
  payload->entry_count = count;
  payload->entries =
      count == 0U ? NULL
                  : (payload_entry_t *)calloc(count, sizeof(payload_entry_t));
  if (count > 0U && payload->entries == NULL)
    return -1;
  uint64_t total_bytes = 0U;
  for (uint32_t index = 0; index < count; index += 1U) {
    uint8_t reserved_entry[3];
    if (reader_string(reader, &payload->entries[index].relative_path,
                      MAX_RELATIVE_PATH_BYTES) != 0 ||
        reader_u8(reader, &payload->entries[index].kind) != 0 ||
        reader_take(reader, reserved_entry, sizeof(reserved_entry)) != 0) {
      return -1;
    }
    if (payload->entries[index].kind == ENTRY_DIRECTORY)
      continue;
    if (payload->entries[index].kind != ENTRY_FILE) {
      reader->failed = 1;
      return -1;
    }
    uint64_t length = 0;
    if (reader_u64(reader, &length) != 0 || length > MAX_STAGE_BYTES ||
        total_bytes + length > MAX_STAGE_BYTES ||
        length > (uint64_t)(reader->length - reader->offset)) {
      reader->failed = 1;
      return -1;
    }
    total_bytes += length;
    payload->entries[index].content_length = (size_t)length;
    if (reader_bytes(reader, &payload->entries[index].content,
                     (size_t)length) != 0)
      return -1;
  }
  return 0;
}

static int parse_request(const uint8_t *bytes, size_t length,
                         request_t *request) {
  reader_t reader = {
      .bytes = bytes, .length = length, .offset = 0U, .failed = 0};
  uint8_t magic[8];
  uint8_t reserved[3];
  uint32_t version = 0;
  if (reader_take(&reader, magic, sizeof(magic)) != 0 ||
      memcmp(magic, REQUEST_MAGIC, 8U) != 0 ||
      reader_u32(&reader, &version) != 0 || version != PROTOCOL_VERSION ||
      reader_u8(&reader, &request->action) != 0 ||
      reader_take(&reader, reserved, sizeof(reserved)) != 0 ||
      request->action < ACTION_CREATE || request->action > ACTION_REMOVE ||
      reader_string(&reader, &request->request_id, MAX_REQUEST_ID_BYTES) != 0 ||
      parse_segments(&reader, &request->root_segments) != 0 ||
      parse_segments(&reader, &request->target_segments) != 0 ||
      parse_identity(&reader, &request->expected_workspace) != 0 ||
      parse_identity(&reader, &request->expected_root) != 0 ||
      parse_identity(&reader, &request->expected_parent) != 0) {
    return -1;
  }
  uint8_t target_reserved[3];
  if (reader_u8(&reader, &request->expected_target.kind) != 0 ||
      reader_take(&reader, target_reserved, sizeof(target_reserved)) != 0 ||
      (request->expected_target.kind != ENTRY_MISSING &&
       request->expected_target.kind != ENTRY_FILE &&
       request->expected_target.kind != ENTRY_DIRECTORY)) {
    return -1;
  }
  if (request->expected_target.kind != ENTRY_MISSING &&
      parse_identity(&reader, &request->expected_target.identity) != 0) {
    return -1;
  }
  if (reader_take(&reader, request->expected_before_fingerprint,
                  FINGERPRINT_BYTES) != 0 ||
      reader_take(&reader, request->expected_after_fingerprint,
                  FINGERPRINT_BYTES) != 0) {
    return -1;
  }
  uint8_t after_reserved[3];
  if (reader_u8(&reader, &request->expected_after_kind) != 0 ||
      reader_take(&reader, after_reserved, sizeof(after_reserved)) != 0 ||
      (request->expected_after_kind != ENTRY_MISSING &&
       request->expected_after_kind != ENTRY_FILE &&
       request->expected_after_kind != ENTRY_DIRECTORY) ||
      parse_payload(&reader, &request->payload) != 0 ||
      reader.offset != reader.length) {
    return -1;
  }
  if (request->target_segments.count == 0U ||
      (request->action == ACTION_REMOVE &&
       request->payload.kind != ENTRY_MISSING) ||
      (request->action != ACTION_REMOVE &&
       request->payload.kind == ENTRY_MISSING)) {
    return -1;
  }
  return reader.failed ? -1 : 0;
}

static void free_segments(segments_t *segments) {
  if (segments == NULL)
    return;
  for (uint32_t index = 0; index < segments->count; index += 1U)
    free(segments->items[index]);
  free(segments->items);
  segments->items = NULL;
  segments->count = 0U;
}

static void free_payload(payload_t *payload) {
  if (payload == NULL)
    return;
  free(payload->content);
  for (uint32_t index = 0; index < payload->entry_count; index += 1U) {
    free(payload->entries[index].relative_path);
    free(payload->entries[index].content);
  }
  free(payload->entries);
  payload->content = NULL;
  payload->entries = NULL;
}

static void free_request(request_t *request) {
  if (request == NULL)
    return;
  free(request->request_id);
  free_segments(&request->root_segments);
  free_segments(&request->target_segments);
  free_payload(&request->payload);
  request->request_id = NULL;
}

static int same_identity(const struct stat *stat_value, identity_t expected) {
  return (uint64_t)stat_value->st_dev == expected.dev &&
         (uint64_t)stat_value->st_ino == expected.ino;
}

static void fingerprint_hex(const uint8_t *fingerprint,
                            char output[FINGERPRINT_HEX_BYTES]) {
  static const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < FINGERPRINT_BYTES; index += 1U) {
    output[index * 2U] = digits[fingerprint[index] >> 4U];
    output[index * 2U + 1U] = digits[fingerprint[index] & 0x0fU];
  }
}

static int fingerprint_file_descriptor(int descriptor, uint8_t output[],
                                       operation_error_t *error) {
  if (lseek(descriptor, 0, SEEK_SET) < 0) {
    set_error(error, error_for_errno(errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1) {
    set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
    return -1;
  }
  uint8_t buffer[64U * 1024U];
  for (;;) {
    ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR)
        continue;
      set_error(error, error_for_errno(errno),
                error == NULL ? 0 : error->changed);
      return -1;
    }
    if (count == 0)
      break;
    if (CC_SHA256_Update(&context, buffer, (CC_LONG)count) != 1) {
      set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
      return -1;
    }
  }
  if (CC_SHA256_Final(output, &context) != 1) {
    set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
    return -1;
  }
  return 0;
}

static int fingerprint_name_compare(const void *left, const void *right) {
  const char *const *left_name = (const char *const *)left;
  const char *const *right_name = (const char *const *)right;
  return strcmp(*left_name, *right_name);
}

static int fingerprint_directory_fd(int descriptor, uint8_t output[],
                                    operation_error_t *error);

static int fingerprint_fd(int descriptor, uint8_t output[],
                          operation_error_t *error) {
  struct stat entry_stat;
  if (fstat(descriptor, &entry_stat) != 0) {
    set_error(error, error_for_errno(errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  if (S_ISREG(entry_stat.st_mode))
    return fingerprint_file_descriptor(descriptor, output, error);
  if (S_ISDIR(entry_stat.st_mode))
    return fingerprint_directory_fd(descriptor, output, error);
  set_error(error, ERROR_CONCURRENT, error == NULL ? 0 : error->changed);
  return -1;
}

static int fingerprint_directory_fd(int descriptor, uint8_t output[],
                                    operation_error_t *error) {
  if (lseek(descriptor, 0, SEEK_SET) < 0) {
    set_error(error, error_for_errno(errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  int scan_descriptor = dup(descriptor);
  DIR *directory = scan_descriptor < 0 ? NULL : fdopendir(scan_descriptor);
  if (directory == NULL) {
    if (scan_descriptor >= 0)
      close(scan_descriptor);
    set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
    return -1;
  }

  char **names = NULL;
  size_t count = 0U;
  size_t capacity = 0U;
  struct dirent *entry = NULL;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    if (count >= MAX_FINGERPRINT_ENTRIES) {
      closedir(directory);
      for (size_t index = 0; index < count; index += 1U)
        free(names[index]);
      free(names);
      set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
      return -1;
    }
    if (count == capacity) {
      size_t next_capacity = capacity == 0U ? 32U : capacity * 2U;
      if (next_capacity > MAX_FINGERPRINT_ENTRIES)
        next_capacity = MAX_FINGERPRINT_ENTRIES;
      char **expanded = (char **)realloc(names, next_capacity * sizeof(char *));
      if (expanded == NULL) {
        closedir(directory);
        for (size_t index = 0; index < count; index += 1U)
          free(names[index]);
        free(names);
        set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
        return -1;
      }
      names = expanded;
      capacity = next_capacity;
    }
    names[count] = strdup(entry->d_name);
    if (names[count] == NULL) {
      closedir(directory);
      for (size_t index = 0; index < count; index += 1U)
        free(names[index]);
      free(names);
      set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
      return -1;
    }
    count += 1U;
  }
  int read_error = errno;
  if (closedir(directory) != 0 || read_error != 0) {
    int saved_errno = read_error != 0 ? read_error : errno;
    for (size_t index = 0; index < count; index += 1U)
      free(names[index]);
    free(names);
    set_error(error, error_for_errno(saved_errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  qsort(names, count, sizeof(char *), fingerprint_name_compare);

  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1) {
    for (size_t index = 0; index < count; index += 1U)
      free(names[index]);
    free(names);
    set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
    return -1;
  }
  for (size_t index = 0; index < count; index += 1U) {
    struct stat child_stat;
    if (fstatat(descriptor, names[index], &child_stat, AT_SYMLINK_NOFOLLOW) !=
        0) {
      int saved_errno = errno;
      for (size_t item = 0; item < count; item += 1U)
        free(names[item]);
      free(names);
      set_error(error, error_for_errno(saved_errno),
                error == NULL ? 0 : error->changed);
      return -1;
    }
    if (S_ISLNK(child_stat.st_mode)) {
      for (size_t item = 0; item < count; item += 1U)
        free(names[item]);
      free(names);
      set_error(error, ERROR_SYMLINK, error == NULL ? 0 : error->changed);
      return -1;
    }
    int child_descriptor =
        openat(descriptor, names[index],
               O_RDONLY | O_NOFOLLOW | O_CLOEXEC |
                   (S_ISDIR(child_stat.st_mode) ? O_DIRECTORY : 0));
    if (child_descriptor < 0) {
      int saved_errno = errno;
      for (size_t item = 0; item < count; item += 1U)
        free(names[item]);
      free(names);
      set_error(error, error_for_errno(saved_errno),
                error == NULL ? 0 : error->changed);
      return -1;
    }
    uint8_t child_fingerprint[FINGERPRINT_BYTES];
    int child_result =
        fingerprint_fd(child_descriptor, child_fingerprint, error);
    int close_result = close(child_descriptor);
    if (child_result != 0 || close_result != 0) {
      for (size_t item = 0; item < count; item += 1U)
        free(names[item]);
      free(names);
      if (child_result == 0)
        set_error(error, error_for_errno(errno),
                  error == NULL ? 0 : error->changed);
      return -1;
    }
    if (index > 0U && CC_SHA256_Update(&context, "\n", 1U) != 1) {
      for (size_t item = 0; item < count; item += 1U)
        free(names[item]);
      free(names);
      set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
      return -1;
    }
    char child_hex[FINGERPRINT_HEX_BYTES];
    fingerprint_hex(child_fingerprint, child_hex);
    if (CC_SHA256_Update(&context, names[index],
                         (CC_LONG)strlen(names[index])) != 1 ||
        CC_SHA256_Update(&context, "\0", 1U) != 1 ||
        CC_SHA256_Update(&context, child_hex, FINGERPRINT_HEX_BYTES) != 1) {
      for (size_t item = 0; item < count; item += 1U)
        free(names[item]);
      free(names);
      set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
      return -1;
    }
  }
  for (size_t index = 0; index < count; index += 1U)
    free(names[index]);
  free(names);
  if (CC_SHA256_Final(output, &context) != 1) {
    set_error(error, ERROR_DURABILITY, error == NULL ? 0 : error->changed);
    return -1;
  }
  return 0;
}

static int fingerprint_entry_at(int parent_fd, const char *name,
                                uint8_t output[], operation_error_t *error) {
  struct stat entry_stat;
  if (fstatat(parent_fd, name, &entry_stat, AT_SYMLINK_NOFOLLOW) != 0) {
    set_error(error, error_for_errno(errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  if (S_ISLNK(entry_stat.st_mode)) {
    set_error(error, ERROR_SYMLINK, error == NULL ? 0 : error->changed);
    return -1;
  }
  if (!S_ISREG(entry_stat.st_mode) && !S_ISDIR(entry_stat.st_mode)) {
    set_error(error, ERROR_CONCURRENT, error == NULL ? 0 : error->changed);
    return -1;
  }
  int descriptor = openat(parent_fd, name,
                          O_RDONLY | O_NOFOLLOW | O_CLOEXEC |
                              (S_ISDIR(entry_stat.st_mode) ? O_DIRECTORY : 0));
  if (descriptor < 0) {
    set_error(error, error_for_errno(errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  int result = fingerprint_fd(descriptor, output, error);
  int saved_errno = errno;
  if (close(descriptor) != 0 && result == 0) {
    set_error(error, error_for_errno(errno),
              error == NULL ? 0 : error->changed);
    result = -1;
  }
  if (result != 0 && error != NULL && error->code == ERROR_NONE)
    set_error(error, error_for_errno(saved_errno), error->changed);
  return result;
}

static int open_directory_entry(int parent_fd, const char *name, int *output_fd,
                                operation_error_t *error) {
  struct stat entry_stat;
  if (fstatat(parent_fd, name, &entry_stat, AT_SYMLINK_NOFOLLOW) != 0) {
    set_error(error, error_for_errno(errno), 0);
    return -1;
  }
  if (S_ISLNK(entry_stat.st_mode)) {
    set_error(error, ERROR_SYMLINK, 0);
    return -1;
  }
  if (!S_ISDIR(entry_stat.st_mode)) {
    set_error(error, ERROR_CONCURRENT, 0);
    return -1;
  }
  int descriptor =
      openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) {
    set_error(error, error_for_errno(errno), 0);
    return -1;
  }
  if (fstat(descriptor, &entry_stat) != 0) {
    int saved_errno = errno;
    close(descriptor);
    set_error(error, error_for_errno(saved_errno), 0);
    return -1;
  }
  *output_fd = descriptor;
  return 0;
}

static int open_root_directory(int workspace_fd, const request_t *request,
                               int *root_fd, operation_error_t *error) {
  int current = dup(workspace_fd);
  if (current < 0) {
    set_error(error, ERROR_DURABILITY, 0);
    return -1;
  }
  for (uint32_t index = 0; index < request->root_segments.count; index += 1U) {
    int next = -1;
    if (open_directory_entry(current, request->root_segments.items[index],
                             &next, error) != 0) {
      close(current);
      return -1;
    }
    close(current);
    current = next;
  }
  struct stat root_stat;
  if (fstat(current, &root_stat) != 0 ||
      !same_identity(&root_stat, request->expected_root)) {
    int saved_errno = errno;
    close(current);
    set_error(
        error,
        saved_errno == 0 ? ERROR_CONCURRENT : error_for_errno(saved_errno), 0);
    return -1;
  }
  *root_fd = current;
  return 0;
}

static int open_target_parent(int root_fd, const request_t *request,
                              int *parent_fd, operation_error_t *error) {
  uint32_t parent_count = request->target_segments.count - 1U;
  int allow_create =
      request->action == ACTION_CREATE || request->action == ACTION_PUBLISH;
  int current = dup(root_fd);
  if (current < 0) {
    set_error(error, ERROR_DURABILITY, 0);
    return -1;
  }
  for (uint32_t index = 0; index < parent_count; index += 1U) {
    const char *segment = request->target_segments.items[index];
    struct stat segment_stat;
    if (fstatat(current, segment, &segment_stat, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno != ENOENT || !allow_create) {
        int saved_errno = errno;
        close(current);
        set_error(error, error_for_errno(saved_errno), 0);
        return -1;
      }
      if (mkdirat(current, segment, 0700) != 0 && errno != EEXIST) {
        int saved_errno = errno;
        close(current);
        set_error(error, error_for_errno(saved_errno), 0);
        return -1;
      }
    } else if (index + 1U == parent_count &&
               request->expected_parent.dev == 0U &&
               request->expected_parent.ino == 0U) {
      close(current);
      set_error(error, ERROR_CONCURRENT, 0);
      return -1;
    }
    int next = -1;
    if (open_directory_entry(current, segment, &next, error) != 0) {
      close(current);
      return -1;
    }
    close(current);
    current = next;
  }
  struct stat parent_stat;
  if (fstat(current, &parent_stat) != 0 ||
      ((request->expected_parent.dev != 0U ||
        request->expected_parent.ino != 0U) &&
       !same_identity(&parent_stat, request->expected_parent))) {
    int saved_errno = errno;
    close(current);
    set_error(
        error,
        saved_errno == 0 ? ERROR_CONCURRENT : error_for_errno(saved_errno), 0);
    return -1;
  }
  *parent_fd = current;
  return 0;
}

static int capture_expected_target(int parent_fd, const request_t *request,
                                   target_capture_t *capture,
                                   operation_error_t *error) {
  const char *target =
      request->target_segments.items[request->target_segments.count - 1U];
  capture->descriptor = -1;
  capture->present = 0;
  memset(&capture->stat_value, 0, sizeof(capture->stat_value));
  struct stat target_stat;
  if (fstatat(parent_fd, target, &target_stat, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT && request->expected_target.kind == ENTRY_MISSING)
      return 0;
    set_error(error,
              errno == ENOENT ? ERROR_CONCURRENT : error_for_errno(errno), 0);
    return -1;
  }
  if (S_ISLNK(target_stat.st_mode)) {
    set_error(error, ERROR_SYMLINK, 0);
    return -1;
  }
  uint8_t actual_kind = S_ISDIR(target_stat.st_mode)   ? ENTRY_DIRECTORY
                        : S_ISREG(target_stat.st_mode) ? ENTRY_FILE
                                                       : ENTRY_MISSING;
  if (request->expected_target.kind == ENTRY_MISSING) {
    set_error(error, ERROR_CONFLICT, 0);
    return -1;
  }
  if (actual_kind != request->expected_target.kind ||
      !same_identity(&target_stat, request->expected_target.identity)) {
    set_error(error, ERROR_CONCURRENT, 0);
    return -1;
  }
  int descriptor =
      openat(parent_fd, target,
             O_RDONLY | O_NOFOLLOW | O_CLOEXEC |
                 (actual_kind == ENTRY_DIRECTORY ? O_DIRECTORY : 0));
  if (descriptor < 0) {
    set_error(error, error_for_errno(errno), 0);
    return -1;
  }
  struct stat descriptor_stat;
  if (fstat(descriptor, &descriptor_stat) != 0 ||
      !same_identity(&descriptor_stat, request->expected_target.identity)) {
    int saved_errno = errno;
    close(descriptor);
    set_error(
        error,
        saved_errno == 0 ? ERROR_CONCURRENT : error_for_errno(saved_errno), 0);
    return -1;
  }
  capture->descriptor = descriptor;
  capture->stat_value = descriptor_stat;
  capture->present = 1;
  return 0;
}

static int parse_relative_path(const char *relative_path, char ***segments,
                               uint32_t *count, operation_error_t *error) {
  size_t length = strlen(relative_path);
  if (length == 0U || length > MAX_RELATIVE_PATH_BYTES ||
      relative_path[0] == '/' || relative_path[length - 1U] == '/' ||
      strchr(relative_path, '\\') != NULL ||
      memchr(relative_path, '\0', length) != NULL) {
    set_error(error, ERROR_PROTOCOL, 0);
    return -1;
  }
  uint32_t segment_count = 1U;
  for (size_t index = 0; index < length; index += 1U) {
    if (relative_path[index] == '/')
      segment_count += 1U;
  }
  if (segment_count > MAX_SEGMENTS) {
    set_error(error, ERROR_PROTOCOL, 0);
    return -1;
  }
  char **result = (char **)calloc(segment_count, sizeof(char *));
  if (result == NULL) {
    set_error(error, ERROR_DURABILITY, 0);
    return -1;
  }
  size_t start = 0U;
  uint32_t result_index = 0U;
  for (size_t index = 0; index <= length; index += 1U) {
    if (index != length && relative_path[index] != '/')
      continue;
    size_t segment_length = index - start;
    if (!safe_segment(relative_path + start, segment_length)) {
      for (uint32_t item = 0; item < result_index; item += 1U)
        free(result[item]);
      free(result);
      set_error(error, ERROR_PROTOCOL, 0);
      return -1;
    }
    result[result_index] = (char *)malloc(segment_length + 1U);
    if (result[result_index] == NULL) {
      for (uint32_t item = 0; item < result_index; item += 1U)
        free(result[item]);
      free(result);
      set_error(error, ERROR_DURABILITY, 0);
      return -1;
    }
    memcpy(result[result_index], relative_path + start, segment_length);
    result[result_index][segment_length] = '\0';
    result_index += 1U;
    start = index + 1U;
  }
  *segments = result;
  *count = segment_count;
  return 0;
}

static void free_path_segments(char **segments, uint32_t count) {
  if (segments == NULL)
    return;
  for (uint32_t index = 0; index < count; index += 1U)
    free(segments[index]);
  free(segments);
}

static int ensure_payload_parent(int root_fd, char **segments, uint32_t count,
                                 int *parent_fd, char **base_name,
                                 operation_error_t *error) {
  if (count == 0U) {
    set_error(error, ERROR_PROTOCOL, 0);
    return -1;
  }
  int current = dup(root_fd);
  if (current < 0) {
    set_error(error, ERROR_DURABILITY, 0);
    return -1;
  }
  for (uint32_t index = 0; index + 1U < count; index += 1U) {
    struct stat existing;
    if (fstatat(current, segments[index], &existing, AT_SYMLINK_NOFOLLOW) !=
        0) {
      if (errno != ENOENT || mkdirat(current, segments[index], 0700) != 0) {
        int saved_errno = errno;
        close(current);
        set_error(error, error_for_errno(saved_errno), 0);
        return -1;
      }
    }
    int next = -1;
    if (open_directory_entry(current, segments[index], &next, error) != 0) {
      close(current);
      return -1;
    }
    close(current);
    current = next;
  }
  *base_name = strdup(segments[count - 1U]);
  if (*base_name == NULL) {
    close(current);
    set_error(error, ERROR_DURABILITY, 0);
    return -1;
  }
  *parent_fd = current;
  return 0;
}

static int write_file_at(int parent_fd, const char *name,
                         const uint8_t *content, size_t length,
                         operation_error_t *error) {
  int descriptor =
      openat(parent_fd, name,
             O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) {
    set_error(error, error_for_errno(errno), 0);
    return -1;
  }
  size_t offset = 0U;
  while (offset < length) {
    ssize_t written = write(descriptor, content + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR)
        continue;
      int saved_errno = errno;
      close(descriptor);
      unlinkat(parent_fd, name, 0);
      set_error(error, error_for_errno(saved_errno), 0);
      return -1;
    }
    if (written == 0) {
      close(descriptor);
      unlinkat(parent_fd, name, 0);
      set_error(error, ERROR_DURABILITY, 0);
      return -1;
    }
    offset += (size_t)written;
  }
  if (fsync(descriptor) != 0 || close(descriptor) != 0) {
    int saved_errno = errno;
    unlinkat(parent_fd, name, 0);
    set_error(error, error_for_errno(saved_errno), 0);
    return -1;
  }
  return 0;
}

static int create_temp_directory(int parent_fd, const char *name,
                                 int *directory_fd, operation_error_t *error) {
  if (mkdirat(parent_fd, name, 0700) != 0) {
    set_error(error, error_for_errno(errno), 0);
    return -1;
  }
  int descriptor =
      openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) {
    int saved_errno = errno;
    unlinkat(parent_fd, name, AT_REMOVEDIR);
    set_error(error, error_for_errno(saved_errno), 0);
    return -1;
  }
  *directory_fd = descriptor;
  return 0;
}

static int materialize_directory_entry(int temp_fd,
                                       const payload_entry_t *entry,
                                       operation_error_t *error) {
  char **segments = NULL;
  uint32_t count = 0;
  if (parse_relative_path(entry->relative_path, &segments, &count, error) != 0)
    return -1;
  int parent_fd = -1;
  char *base_name = NULL;
  if (ensure_payload_parent(temp_fd, segments, count, &parent_fd, &base_name,
                            error) != 0) {
    free_path_segments(segments, count);
    return -1;
  }
  int result = 0;
  if (entry->kind == ENTRY_DIRECTORY) {
    if (mkdirat(parent_fd, base_name, 0700) != 0 && errno != EEXIST) {
      set_error(error, error_for_errno(errno), 0);
      result = -1;
    }
  } else if (entry->kind == ENTRY_FILE) {
    result = write_file_at(parent_fd, base_name, entry->content,
                           entry->content_length, error);
  } else {
    set_error(error, ERROR_PROTOCOL, 0);
    result = -1;
  }
  if (result == 0) {
    struct stat check;
    if (fstatat(parent_fd, base_name, &check, AT_SYMLINK_NOFOLLOW) != 0 ||
        (entry->kind == ENTRY_DIRECTORY && !S_ISDIR(check.st_mode)) ||
        (entry->kind == ENTRY_FILE && !S_ISREG(check.st_mode))) {
      set_error(error, ERROR_CONCURRENT, 0);
      result = -1;
    }
  }
  close(parent_fd);
  free(base_name);
  free_path_segments(segments, count);
  return result;
}

static int materialize_payload(int parent_fd, const request_t *request,
                               char *temp_name, operation_error_t *error) {
  int suffix = 0;
  snprintf(temp_name, NAME_MAX, ".moss-canonical-tmp-%ld", (long)getpid());
  for (;;) {
    struct stat ignored;
    if (fstatat(parent_fd, temp_name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
        errno == ENOENT)
      break;
    suffix += 1;
    if (suffix > 1000) {
      set_error(error, ERROR_CONFLICT, 0);
      return -1;
    }
    snprintf(temp_name, NAME_MAX, ".moss-canonical-tmp-%ld-%d", (long)getpid(),
             suffix);
  }
  if (request->payload.kind == ENTRY_FILE) {
    return write_file_at(parent_fd, temp_name, request->payload.content,
                         request->payload.content_length, error);
  }
  int temp_fd = -1;
  if (create_temp_directory(parent_fd, temp_name, &temp_fd, error) != 0)
    return -1;
  for (uint32_t index = 0; index < request->payload.entry_count; index += 1U) {
    if (materialize_directory_entry(temp_fd, &request->payload.entries[index],
                                    error) != 0) {
      close(temp_fd);
      return -1;
    }
  }
  int result = fsync(temp_fd);
  int saved_errno = errno;
  close(temp_fd);
  if (result != 0) {
    set_error(error, error_for_errno(saved_errno), 0);
    return -1;
  }
  return 0;
}

static int rename_exclusive(int parent_fd, const char *source,
                            const char *target, operation_error_t *error) {
  if (renameatx_np(parent_fd, source, parent_fd, target,
                   RENAME_EXCL | RENAME_NOFOLLOW_ANY) != 0) {
    set_error(error, error_for_errno(errno), 0);
    return -1;
  }
  return 0;
}

static int remove_entry_at(int parent_fd, const char *name, int *changed,
                           operation_error_t *error) {
  struct stat entry_stat;
  if (fstatat(parent_fd, name, &entry_stat, AT_SYMLINK_NOFOLLOW) != 0) {
    set_error(error, error_for_errno(errno), *changed);
    return -1;
  }
  if (S_ISLNK(entry_stat.st_mode)) {
    set_error(error, ERROR_SYMLINK, *changed);
    return -1;
  }
  if (!S_ISDIR(entry_stat.st_mode)) {
    if (unlinkat(parent_fd, name, 0) != 0) {
      set_error(error, error_for_errno(errno), *changed);
      return -1;
    }
    *changed = 1;
    return 0;
  }
  int directory_fd =
      openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) {
    set_error(error, error_for_errno(errno), *changed);
    return -1;
  }
  int scan_fd = dup(directory_fd);
  DIR *directory = scan_fd < 0 ? NULL : fdopendir(scan_fd);
  if (directory == NULL) {
    if (scan_fd >= 0)
      close(scan_fd);
    close(directory_fd);
    set_error(error, ERROR_DURABILITY, *changed);
    return -1;
  }
  struct dirent *entry = NULL;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    if (remove_entry_at(directory_fd, entry->d_name, changed, error) != 0) {
      closedir(directory);
      close(directory_fd);
      return -1;
    }
  }
  int read_error = errno;
  if (closedir(directory) != 0 || read_error != 0 || fsync(directory_fd) != 0) {
    int saved_errno = read_error != 0 ? read_error : errno;
    close(directory_fd);
    set_error(error, error_for_errno(saved_errno), *changed);
    return -1;
  }
  close(directory_fd);
  if (unlinkat(parent_fd, name, AT_REMOVEDIR) != 0) {
    set_error(error, error_for_errno(errno), *changed);
    return -1;
  }
  *changed = 1;
  return 0;
}

static int verify_captured_target(int parent_fd, const char *target_name,
                                  const target_capture_t *capture,
                                  const uint8_t expected_fingerprint[],
                                  operation_error_t *error) {
  if (!capture->present || capture->descriptor < 0) {
    set_error(error, ERROR_CONCURRENT, error == NULL ? 0 : error->changed);
    return -1;
  }
  uint8_t observed_fingerprint[FINGERPRINT_BYTES];
  if (fingerprint_fd(capture->descriptor, observed_fingerprint, error) != 0)
    return -1;
  if (memcmp(observed_fingerprint, expected_fingerprint, FINGERPRINT_BYTES) !=
      0) {
    set_error(error, ERROR_CONCURRENT, error == NULL ? 0 : error->changed);
    return -1;
  }
  struct stat path_stat;
  if (fstatat(parent_fd, target_name, &path_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_identity(&path_stat,
                     (identity_t){(uint64_t)capture->stat_value.st_dev,
                                  (uint64_t)capture->stat_value.st_ino})) {
    int saved_errno = errno;
    set_error(error,
              saved_errno == 0 ? ERROR_CONCURRENT
                               : error_for_errno(saved_errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  return 0;
}

static int verify_captured_backup(int parent_fd, const char *backup_name,
                                  const target_capture_t *capture,
                                  const uint8_t expected_fingerprint[],
                                  operation_error_t *error) {
  if (!capture->present || capture->descriptor < 0) {
    set_error(error, ERROR_CONCURRENT, error == NULL ? 0 : error->changed);
    return -1;
  }
  uint8_t observed_fingerprint[FINGERPRINT_BYTES];
  if (fingerprint_fd(capture->descriptor, observed_fingerprint, error) != 0)
    return -1;
  if (memcmp(observed_fingerprint, expected_fingerprint, FINGERPRINT_BYTES) !=
      0) {
    set_error(error, ERROR_CONCURRENT, error == NULL ? 0 : error->changed);
    return -1;
  }
  struct stat backup_stat;
  if (fstatat(parent_fd, backup_name, &backup_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_identity(&backup_stat,
                     (identity_t){(uint64_t)capture->stat_value.st_dev,
                                  (uint64_t)capture->stat_value.st_ino})) {
    int saved_errno = errno;
    set_error(error,
              saved_errno == 0 ? ERROR_CONCURRENT
                               : error_for_errno(saved_errno),
              error == NULL ? 0 : error->changed);
    return -1;
  }
  return 0;
}

static int restore_captured_target(int parent_fd, const char *backup_name,
                                   const char *target_name, uint8_t *rollback,
                                   operation_error_t *error) {
  operation_error_t restore_error = {.code = ERROR_NONE, .changed = 1};
  if (rename_exclusive(parent_fd, backup_name, target_name, &restore_error) !=
      0) {
    *rollback = ROLLBACK_FAILED;
    error->code = restore_error.code == ERROR_NONE ? ERROR_DURABILITY
                                                   : restore_error.code;
    error->changed = 1;
    return -1;
  }
  if (fsync(parent_fd) != 0) {
    *rollback = ROLLBACK_FAILED;
    error->code = error_for_errno(errno);
    error->changed = 1;
    return -1;
  }
  *rollback = ROLLBACK_RESTORED;
  error->changed = 0;
  return -1;
}

static int cleanup_temporary(int parent_fd, const char *temporary_name,
                             operation_error_t *error) {
  struct stat temporary_stat;
  if (fstatat(parent_fd, temporary_name, &temporary_stat,
              AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT)
      return 0;
    set_error(error, error_for_errno(errno), 1);
    return -1;
  }
  int changed = 0;
  operation_error_t cleanup_error = {.code = ERROR_NONE, .changed = 1};
  if (remove_entry_at(parent_fd, temporary_name, &changed, &cleanup_error) !=
      0) {
    error->code = cleanup_error.code == ERROR_NONE ? ERROR_DURABILITY
                                                   : cleanup_error.code;
    error->changed = 1;
    return -1;
  }
  return 0;
}

static int stat_after(int parent_fd, const request_t *request,
                      struct stat *after, operation_error_t *error) {
  const char *target =
      request->target_segments.items[request->target_segments.count - 1U];
  if (fstatat(parent_fd, target, after, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT && request->expected_after_kind == ENTRY_MISSING)
      return 0;
    set_error(error, error_for_errno(errno), 1);
    return -1;
  }
  if (S_ISLNK(after->st_mode)) {
    set_error(error, ERROR_SYMLINK, 1);
    return -1;
  }
  uint8_t kind = S_ISDIR(after->st_mode)   ? ENTRY_DIRECTORY
                 : S_ISREG(after->st_mode) ? ENTRY_FILE
                                           : ENTRY_MISSING;
  if (kind != request->expected_after_kind) {
    set_error(error, ERROR_CONCURRENT, 1);
    return -1;
  }
  return 0;
}

static int make_backup_name(int parent_fd, char output[NAME_MAX],
                            operation_error_t *error) {
  for (int suffix = 0; suffix <= 1000; suffix += 1) {
    int written = suffix == 0
                      ? snprintf(output, NAME_MAX,
                                 ".moss-canonical-backup-%ld", (long)getpid())
                      : snprintf(output, NAME_MAX,
                                 ".moss-canonical-backup-%ld-%d",
                                 (long)getpid(), suffix);
    if (written < 0 || written >= NAME_MAX) {
      set_error(error, ERROR_CONFLICT, 0);
      return -1;
    }
    struct stat ignored;
    if (fstatat(parent_fd, output, &ignored, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT)
        return 0;
      set_error(error, error_for_errno(errno), 0);
      return -1;
    }
  }
  set_error(error, ERROR_CONFLICT, 0);
  return -1;
}

#ifdef MOSS_CANONICAL_FS_TEST_HOOKS
static int wait_test_barrier_named(const char *variable,
                                   operation_error_t *error) {
  const char *base = getenv(variable);
  if (base == NULL || base[0] == '\0' || strlen(base) > PATH_MAX - 8U)
    return 0;
  char ready_path[PATH_MAX];
  char release_path[PATH_MAX];
  snprintf(ready_path, sizeof(ready_path), "%s.ready", base);
  snprintf(release_path, sizeof(release_path), "%s.release", base);
  int ready_fd =
      open(ready_path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (ready_fd < 0 || close(ready_fd) != 0) {
    if (ready_fd >= 0)
      close(ready_fd);
    set_error(error, ERROR_DURABILITY, 0);
    return -1;
  }
  for (int attempt = 0; attempt < 10000; attempt += 1) {
    if (access(release_path, F_OK) == 0)
      return 0;
    if (errno != ENOENT)
      break;
    usleep(1000);
  }
  set_error(error, ERROR_DURABILITY, 0);
  return -1;
}

static int wait_test_barrier(operation_error_t *error) {
  return wait_test_barrier_named("MOSS_CANONICAL_FS_TEST_BARRIER", error);
}

static int remove_before_unlink_barrier_waited = 0;

static int wait_remove_before_unlink_test_barrier(operation_error_t *error) {
  if (remove_before_unlink_barrier_waited)
    return 0;
  int result = wait_test_barrier_named(
      "MOSS_CANONICAL_FS_TEST_REMOVE_BEFORE_UNLINK_BARRIER", error);
  if (result == 0 &&
      getenv("MOSS_CANONICAL_FS_TEST_REMOVE_BEFORE_UNLINK_BARRIER") != NULL)
    remove_before_unlink_barrier_waited = 1;
  return result;
}

static int force_replace_rollback_failure(void) {
  const char *value = getenv("MOSS_CANONICAL_FS_TEST_REPLACE_ROLLBACK_FAILURE");
  return value != NULL && strcmp(value, "1") == 0;
}

static int force_backup_cleanup_failure(void) {
  const char *value = getenv("MOSS_CANONICAL_FS_TEST_BACKUP_CLEANUP_FAILURE");
  return value != NULL && strcmp(value, "1") == 0;
}
#endif

static void stat_to_response(const struct stat *stat_value, uint8_t *kind,
                             uint64_t *dev, uint64_t *ino, uint32_t *mode,
                             uint64_t *ctime_seconds,
                             uint32_t *ctime_nanoseconds) {
  if (stat_value == NULL) {
    *kind = ENTRY_MISSING;
    *dev = 0;
    *ino = 0;
    *mode = 0;
    *ctime_seconds = 0;
    *ctime_nanoseconds = 0;
    return;
  }
  *kind = S_ISDIR(stat_value->st_mode)   ? ENTRY_DIRECTORY
          : S_ISREG(stat_value->st_mode) ? ENTRY_FILE
                                         : ENTRY_MISSING;
  *dev = (uint64_t)stat_value->st_dev;
  *ino = (uint64_t)stat_value->st_ino;
  *mode = (uint32_t)stat_value->st_mode;
  *ctime_seconds = (uint64_t)stat_value->st_ctimespec.tv_sec;
  *ctime_nanoseconds = (uint32_t)stat_value->st_ctimespec.tv_nsec;
}

static int write_u32(uint32_t value) {
  uint8_t bytes[4] = {(uint8_t)(value >> 24U), (uint8_t)(value >> 16U),
                      (uint8_t)(value >> 8U), (uint8_t)value};
  return write_all(STDOUT_FILENO, bytes, sizeof(bytes));
}

static int write_u64(uint64_t value) {
  uint8_t bytes[8] = {(uint8_t)(value >> 56U), (uint8_t)(value >> 48U),
                      (uint8_t)(value >> 40U), (uint8_t)(value >> 32U),
                      (uint8_t)(value >> 24U), (uint8_t)(value >> 16U),
                      (uint8_t)(value >> 8U),  (uint8_t)value};
  return write_all(STDOUT_FILENO, bytes, sizeof(bytes));
}

static int write_u8(uint8_t value) {
  return write_all(STDOUT_FILENO, &value, sizeof(value));
}

static int write_string(const char *value, size_t maximum_length) {
  const char *effective = value == NULL ? "" : value;
  size_t length = strlen(effective);
  if (length > maximum_length || write_u32((uint32_t)length) != 0)
    return -1;
  return length == 0U ? 0 : write_all(STDOUT_FILENO, effective, length);
}

static int write_response(const char *request_id, uint8_t status,
                          uint8_t error_code, uint8_t rollback,
                          const struct stat *after, const struct stat *parent,
                          const uint8_t after_fingerprint[],
                          const char *message) {
  uint8_t kind = ENTRY_MISSING;
  uint64_t dev = 0;
  uint64_t ino = 0;
  uint32_t mode = 0;
  uint64_t ctime_seconds = 0;
  uint32_t ctime_nanoseconds = 0;
  stat_to_response(after, &kind, &dev, &ino, &mode, &ctime_seconds,
                   &ctime_nanoseconds);
  uint64_t parent_dev = parent == NULL ? 0U : (uint64_t)parent->st_dev;
  uint64_t parent_ino = parent == NULL ? 0U : (uint64_t)parent->st_ino;
  const uint8_t *fingerprint = after_fingerprint;
  uint8_t empty_fingerprint[FINGERPRINT_BYTES] = {0};
  if (fingerprint == NULL)
    fingerprint = empty_fingerprint;
  if (write_all(STDOUT_FILENO, RESPONSE_MAGIC, 8U) != 0 ||
      write_u32(PROTOCOL_VERSION) != 0 || write_u8(status) != 0 ||
      write_u8(error_code) != 0 || write_u8(rollback) != 0 ||
      write_u8(kind) != 0 || write_u64(dev) != 0 || write_u64(ino) != 0 ||
      write_u32(mode) != 0 || write_u64(ctime_seconds) != 0 ||
      write_u32(ctime_nanoseconds) != 0 || write_u64(parent_dev) != 0 ||
      write_u64(parent_ino) != 0 ||
      write_all(STDOUT_FILENO, fingerprint, FINGERPRINT_BYTES) != 0 ||
      write_string(request_id, MAX_REQUEST_ID_BYTES) != 0 ||
      write_string(message, MAX_RESPONSE_MESSAGE_BYTES) != 0) {
    return -1;
  }
  return 0;
}

static uint8_t status_for_error(const operation_error_t *error) {
  if (error->changed)
    return STATUS_RECOVERY_NEEDED;
  if (error->code == ERROR_CONFLICT)
    return STATUS_CONFLICT;
  return STATUS_ERROR;
}

static int perform_request(const request_t *request, uint8_t *status,
                           uint8_t *error_code, uint8_t *rollback,
                           struct stat *after, struct stat *parent_after,
                           uint8_t after_fingerprint[]) {
  operation_error_t error = {.code = ERROR_NONE, .changed = 0};
  target_capture_t capture = {.descriptor = -1, .present = 0};
  char temporary_name[NAME_MAX] = {0};
  char backup_name[NAME_MAX] = {0};
  int backup_present = 0;
  int workspace_fd = open(".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (workspace_fd < 0) {
    set_error(&error, error_for_errno(errno), 0);
    goto failed;
  }
  struct stat workspace_stat;
  if (fstat(workspace_fd, &workspace_stat) != 0 ||
      !same_identity(&workspace_stat, request->expected_workspace)) {
    set_error(&error, ERROR_CONCURRENT, 0);
    goto failed_workspace;
  }
  int root_fd = -1;
  if (open_root_directory(workspace_fd, request, &root_fd, &error) != 0)
    goto failed_workspace;
  int parent_fd = -1;
  if (open_target_parent(root_fd, request, &parent_fd, &error) != 0)
    goto failed_root;
  if (capture_expected_target(parent_fd, request, &capture, &error) != 0)
    goto failed_parent;

  if (request->action != ACTION_REMOVE &&
      materialize_payload(parent_fd, request, temporary_name, &error) != 0) {
    goto failed_temporary;
  }

#ifdef MOSS_CANONICAL_FS_TEST_HOOKS
  if (wait_test_barrier(&error) != 0)
    goto failed_temporary;
#endif

  const char *target_name =
      request->target_segments.items[request->target_segments.count - 1U];
  if (capture.present &&
      verify_captured_target(parent_fd, target_name, &capture,
                             request->expected_before_fingerprint, &error) != 0)
    goto failed_temporary;
  if (request->action != ACTION_REMOVE) {
    uint8_t staged_fingerprint[FINGERPRINT_BYTES];
    if (fingerprint_entry_at(parent_fd, temporary_name, staged_fingerprint,
                             &error) != 0 ||
        memcmp(staged_fingerprint, request->expected_after_fingerprint,
               FINGERPRINT_BYTES) != 0) {
      if (error.code == ERROR_NONE)
        set_error(&error, ERROR_CONCURRENT, 0);
      goto failed_temporary;
    }
  }
  if (request->action == ACTION_CREATE || request->action == ACTION_PUBLISH) {
    if (rename_exclusive(parent_fd, temporary_name, target_name, &error) != 0)
      goto failed_temporary;
    error.changed = 1;
  } else if (request->action == ACTION_REPLACE) {
    if (!capture.present) {
      set_error(&error, ERROR_CONCURRENT, 0);
      goto failed_temporary;
    }
    if (make_backup_name(parent_fd, backup_name, &error) != 0)
      goto failed_temporary;
    if (rename_exclusive(parent_fd, target_name, backup_name, &error) != 0)
      goto failed_temporary;
    error.changed = 1;
    backup_present = 1;
    if (verify_captured_backup(parent_fd, backup_name, &capture,
                               request->expected_before_fingerprint,
                               &error) != 0) {
      if (error.code == ERROR_NONE)
        set_error(&error, ERROR_DURABILITY, 1);
      restore_captured_target(parent_fd, backup_name, target_name, rollback,
                              &error);
      if (*rollback == ROLLBACK_RESTORED)
        backup_present = 0;
      goto failed_temporary;
    }
#ifdef MOSS_CANONICAL_FS_TEST_HOOKS
    if (force_replace_rollback_failure()) {
      int collision =
          openat(parent_fd, target_name,
                 O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
      if (collision >= 0)
        close(collision);
    }
#endif
    if (rename_exclusive(parent_fd, temporary_name, target_name, &error) != 0) {
      restore_captured_target(parent_fd, backup_name, target_name, rollback,
                              &error);
      if (*rollback == ROLLBACK_RESTORED)
        backup_present = 0;
      goto failed_temporary;
    }
    error.changed = 1;
#ifdef MOSS_CANONICAL_FS_TEST_HOOKS
    if (force_backup_cleanup_failure()) {
      set_error(&error, ERROR_DURABILITY, 1);
      goto failed_parent;
    }
#endif
    int backup_changed = 0;
    operation_error_t cleanup_error = {.code = ERROR_NONE, .changed = 1};
    if (remove_entry_at(parent_fd, backup_name, &backup_changed,
                        &cleanup_error) != 0) {
      error.code = cleanup_error.code == ERROR_NONE ? ERROR_DURABILITY
                                                    : cleanup_error.code;
      error.changed = 1;
      goto failed_parent;
    }
    backup_present = 0;
  } else if (request->action == ACTION_REMOVE) {
    if (!capture.present) {
      set_error(&error, ERROR_CONCURRENT, 0);
      goto failed_parent;
    }
    if (make_backup_name(parent_fd, backup_name, &error) != 0)
      goto failed_parent;
    if (rename_exclusive(parent_fd, target_name, backup_name, &error) != 0)
      goto failed_parent;
    error.changed = 1;
    backup_present = 1;
    if (verify_captured_backup(parent_fd, backup_name, &capture,
                               request->expected_before_fingerprint,
                               &error) != 0) {
      if (error.code == ERROR_NONE)
        set_error(&error, ERROR_DURABILITY, 1);
      restore_captured_target(parent_fd, backup_name, target_name, rollback,
                              &error);
      if (*rollback == ROLLBACK_RESTORED)
        backup_present = 0;
      goto failed_parent;
    }
    /*
     * The rename above is the descriptor-relative quarantine for remove.
     * Never unlink this inode here: a same-UID writer may have changed the
     * open inode after the CAS check, and deleting it would destroy the only
     * recoverable copy. The hidden backup is a durable tombstone for later
     * recovery/GC.
     */
    uint8_t observed_fingerprint[FINGERPRINT_BYTES];
    if (fingerprint_fd(capture.descriptor, observed_fingerprint, &error) != 0)
      goto failed_parent;
    if (memcmp(observed_fingerprint, request->expected_before_fingerprint,
               FINGERPRINT_BYTES) != 0) {
      if (fsync(parent_fd) != 0) {
        set_error(&error, error_for_errno(errno), 1);
        goto failed_parent;
      }
      set_error(&error, ERROR_CONCURRENT, 0);
      backup_present = 0;
      goto failed_parent;
    }
#ifdef MOSS_CANONICAL_FS_TEST_HOOKS
    if (wait_remove_before_unlink_test_barrier(&error) != 0)
      goto failed_parent;
#endif
    if (fingerprint_fd(capture.descriptor, observed_fingerprint, &error) != 0)
      goto failed_parent;
    if (memcmp(observed_fingerprint, request->expected_before_fingerprint,
               FINGERPRINT_BYTES) != 0) {
      if (fsync(parent_fd) != 0) {
        set_error(&error, error_for_errno(errno), 1);
        goto failed_parent;
      }
      set_error(&error, ERROR_CONCURRENT, 0);
      backup_present = 0;
      goto failed_parent;
    }
  } else {
    set_error(&error, ERROR_PROTOCOL, error.changed);
    goto failed_parent;
  }

  if (fsync(parent_fd) != 0) {
    set_error(&error, error_for_errno(errno), 1);
    goto failed_parent;
  }
  if (fstat(parent_fd, parent_after) != 0) {
    set_error(&error, error_for_errno(errno), 1);
    goto failed_parent;
  }
  if (stat_after(parent_fd, request, after, &error) != 0)
    goto failed_parent;
  if (after->st_mode == 0) {
    memcpy(after_fingerprint, request->expected_after_fingerprint,
           FINGERPRINT_BYTES);
  } else if (fingerprint_entry_at(parent_fd, target_name, after_fingerprint,
                                  &error) != 0 ||
             memcmp(after_fingerprint, request->expected_after_fingerprint,
                    FINGERPRINT_BYTES) != 0) {
    if (error.code == ERROR_NONE)
      set_error(&error, ERROR_CONCURRENT, 1);
    goto failed_parent;
  }
  if (request->action == ACTION_REMOVE) {
    if (fingerprint_fd(capture.descriptor, after_fingerprint, &error) != 0)
      goto failed_parent;
    if (memcmp(after_fingerprint, request->expected_before_fingerprint,
               FINGERPRINT_BYTES) != 0) {
      if (fsync(parent_fd) != 0) {
        set_error(&error, error_for_errno(errno), 1);
        goto failed_parent;
      }
      set_error(&error, ERROR_CONCURRENT, 0);
      backup_present = 0;
      goto failed_parent;
    }
    memcpy(after_fingerprint, request->expected_after_fingerprint,
           FINGERPRINT_BYTES);
  }
  /* A successful remove intentionally retains its hidden quarantine tombstone. */
  backup_present = 0;
  *status = STATUS_COMMITTED;
  *error_code = ERROR_NONE;
  if (capture.descriptor >= 0)
    close(capture.descriptor);
  close(parent_fd);
  close(root_fd);
  close(workspace_fd);
  return 0;

failed_temporary:
  if (temporary_name[0] != '\0' &&
      cleanup_temporary(parent_fd, temporary_name, &error) != 0)
    error.changed = 1;
failed_parent:
  if (backup_present)
    error.changed = 1;
  if (capture.descriptor >= 0)
    close(capture.descriptor);
  close(parent_fd);
failed_root:
  close(root_fd);
failed_workspace:
  close(workspace_fd);
failed:
  *status = status_for_error(&error);
  *error_code = error.code == ERROR_NONE ? ERROR_DURABILITY : error.code;
  return -1;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (write_all(STDOUT_FILENO, READY_LINE, sizeof(READY_LINE) - 1U) != 0)
    return 2;

  uint8_t *request_bytes = NULL;
  size_t request_length = 0U;
  if (read_request(&request_bytes, &request_length) != 0) {
    write_response(
        "protocol", STATUS_ERROR, ERROR_PROTOCOL, ROLLBACK_NONE, NULL, NULL,
        NULL,
        "Canonical filesystem helper request exceeded its protocol boundary.");
    return 0;
  }

  request_t request;
  memset(&request, 0, sizeof(request));
  if (parse_request(request_bytes, request_length, &request) != 0) {
    free(request_bytes);
    write_response("protocol", STATUS_ERROR, ERROR_PROTOCOL, ROLLBACK_NONE,
                   NULL, NULL, NULL,
                   "Canonical filesystem helper request failed validation.");
    return 0;
  }
  free(request_bytes);

  uint8_t status = STATUS_ERROR;
  uint8_t error_code = ERROR_DURABILITY;
  uint8_t rollback = ROLLBACK_NONE;
  struct stat after;
  struct stat parent_after;
  uint8_t after_fingerprint[FINGERPRINT_BYTES] = {0};
  memset(&after, 0, sizeof(after));
  memset(&parent_after, 0, sizeof(parent_after));
  perform_request(&request, &status, &error_code, &rollback, &after,
                  &parent_after, after_fingerprint);
  const char *message =
      status == STATUS_COMMITTED         ? "committed"
      : status == STATUS_RECOVERY_NEEDED ? "filesystem state requires recovery"
      : status == STATUS_CONFLICT        ? "filesystem conflict"
                                         : "filesystem operation failed";
  write_response(request.request_id, status, error_code, rollback,
                 status == STATUS_COMMITTED ? &after : NULL,
                 status == STATUS_COMMITTED ? &parent_after : NULL,
                 status == STATUS_COMMITTED ? after_fingerprint : NULL,
                 message);
  free_request(&request);
  return 0;
}
