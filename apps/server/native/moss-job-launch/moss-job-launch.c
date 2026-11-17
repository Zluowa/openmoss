/*
 * moss-job-launch.exe: run one program on Windows inside a new kill-on-close Job Object.
 *
 * Why: libuv (Node's process layer) keeps the backend's children in a job that allows silent
 * breakaway, so it holds direct children only. A program the backend starts, such as
 * `codex exec`, can start processes that outlive the request and the backend. Started through
 * this launcher, the program is created already inside a job of its own: when the launcher exits
 * for any reason (the program ended, Moss terminated the launcher, the backend died and took the
 * launcher with it), Windows closes the job and ends every process in it, at any depth.
 *
 * Input, from the environment (no shell, no quoting layer of its own):
 *   MOSS_JOB_CMDLINE  the complete command line, already quoted for CommandLineToArgvW.
 *   MOSS_JOB_APP      optional absolute path of the executable; empty or absent lets
 *                     CreateProcess take it from the command line.
 * Both are removed from the environment before the program starts. The prompt and any other
 * large input travel over stdin, which the program inherits with stdout and stderr.
 *
 * Output: the program's exit code, or one of the MOSS_JOB_LAUNCH_EXIT_* codes below, with one
 * line of UTF-8 on stderr naming the step that failed and the Windows error number. All codes
 * but CREATE_PROCESS are failures of the launcher itself; CREATE_PROCESS means the program
 * could not be started (missing, blocked by policy, not an executable), which is the
 * program's problem and is reported like any failed start.
 *
 * Built without the C runtime (kernel32 only), so the bytes depend on the compiler and linker
 * alone; see build-windows-job-launcher.mjs and moss-job-launch.pin.json.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

/* Distinct from any code Codex or a shell returns: 0x4D4A4C00 ("MJL") plus the failed step. */
#define MOSS_JOB_LAUNCH_EXIT_BASE 0x4D4A4C00u
#define MOSS_JOB_LAUNCH_EXIT_INPUT (MOSS_JOB_LAUNCH_EXIT_BASE + 1u)
#define MOSS_JOB_LAUNCH_EXIT_CREATE_JOB (MOSS_JOB_LAUNCH_EXIT_BASE + 2u)
#define MOSS_JOB_LAUNCH_EXIT_JOB_LIMITS (MOSS_JOB_LAUNCH_EXIT_BASE + 3u)
#define MOSS_JOB_LAUNCH_EXIT_ATTRIBUTES (MOSS_JOB_LAUNCH_EXIT_BASE + 4u)
#define MOSS_JOB_LAUNCH_EXIT_CREATE_PROCESS (MOSS_JOB_LAUNCH_EXIT_BASE + 5u)
#define MOSS_JOB_LAUNCH_EXIT_WAIT (MOSS_JOB_LAUNCH_EXIT_BASE + 6u)
#define MOSS_JOB_LAUNCH_EXIT_JOB_REFUSED (MOSS_JOB_LAUNCH_EXIT_BASE + 7u)

/* Writes "moss-job-launch: <step> failed (Windows error <n>)\n" to stderr; ASCII is UTF-8. */
static DWORD fail(DWORD exitCode, const char *step, DWORD error) {
  char line[160];
  DWORD length = 0;
  const char *prefix = "moss-job-launch: ";
  const char *middle = " failed (Windows error ";
  for (const char *p = prefix; *p; ++p) line[length++] = *p;
  for (const char *p = step; *p && length < 100; ++p) line[length++] = *p;
  for (const char *p = middle; *p; ++p) line[length++] = *p;
  char digits[10];
  DWORD count = 0;
  do {
    digits[count++] = (char)('0' + error % 10u);
    error /= 10u;
  } while (error != 0u && count < sizeof digits);
  while (count > 0u) line[length++] = digits[--count];
  line[length++] = ')';
  line[length++] = '\n';
  DWORD written = 0;
  /* GetStdHandle: stderr is the backend's pipe, inherited from libuv. */
  HANDLE standardError = GetStdHandle(STD_ERROR_HANDLE);
  if (standardError != NULL && standardError != INVALID_HANDLE_VALUE) {
    /* WriteFile, not a console API: raw bytes, so the backend reads exactly this UTF-8. */
    WriteFile(standardError, line, length, &written, NULL);
  }
  return exitCode;
}

/* Reads one environment variable into a new heap buffer, then removes it from this process. */
static WCHAR *takeEnvironmentVariable(const WCHAR *name) {
  /* GetEnvironmentVariableW with no buffer returns the size needed, including the final NUL. */
  DWORD size = GetEnvironmentVariableW(name, NULL, 0);
  if (size == 0u) return NULL;
  /* HeapAlloc: no C runtime here, and command lines can reach 32,767 characters. */
  WCHAR *value = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size * sizeof(WCHAR));
  if (value == NULL) return NULL;
  if (GetEnvironmentVariableW(name, value, size) + 1u != size) return NULL;
  /* SetEnvironmentVariableW(name, NULL) deletes it, so the program does not inherit it. */
  SetEnvironmentVariableW(name, NULL);
  return value;
}

static DWORD run(void) {
  WCHAR *commandLine = takeEnvironmentVariable(L"MOSS_JOB_CMDLINE");
  /* GetLastError now: the next lookup overwrites it. An empty value is invalid data. */
  DWORD commandLineError = commandLine == NULL ? GetLastError() : ERROR_INVALID_DATA;
  WCHAR *application = takeEnvironmentVariable(L"MOSS_JOB_APP");
  if (commandLine == NULL || commandLine[0] == L'\0') {
    return fail(MOSS_JOB_LAUNCH_EXIT_INPUT, "reading MOSS_JOB_CMDLINE", commandLineError);
  }
  if (application != NULL && application[0] == L'\0') application = NULL;

  /* CreateJobObjectW: a new, unnamed job; this process holds its only handle. */
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) return fail(MOSS_JOB_LAUNCH_EXIT_CREATE_JOB, "CreateJobObject", GetLastError());

  /*
   * SetInformationJobObject: KILL_ON_JOB_CLOSE ends every process in the job when the last
   * handle closes, which is when this launcher exits or is terminated. No BREAKAWAY_OK flag,
   * so nothing the program starts can leave the job. DIE_ON_UNHANDLED_EXCEPTION keeps a
   * crashing process from waiting on an error-report dialog nobody sees.
   */
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  SecureZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
    return fail(MOSS_JOB_LAUNCH_EXIT_JOB_LIMITS, "SetInformationJobObject", GetLastError());
  }

  /*
   * InitializeProcThreadAttributeList / UpdateProcThreadAttribute: PROC_THREAD_ATTRIBUTE_JOB_LIST
   * makes CreateProcess put the new process in the job before its first instruction runs. No
   * suspended start, no assign step, no moment in which it runs outside the job.
   */
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attributeSize);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes =
      (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attributeSize);
  if (attributes == NULL || !InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize)) {
    return fail(MOSS_JOB_LAUNCH_EXIT_ATTRIBUTES, "InitializeProcThreadAttributeList", GetLastError());
  }
  HANDLE jobs[1] = {job};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof jobs,
                                 NULL, NULL)) {
    return fail(MOSS_JOB_LAUNCH_EXIT_ATTRIBUTES, "UpdateProcThreadAttribute", GetLastError());
  }

  /*
   * STARTF_USESTDHANDLES with this process's own standard handles: the program reads and writes
   * the backend's pipes directly, as if the backend had started it.
   */
  STARTUPINFOEXW startup;
  SecureZeroMemory(&startup, sizeof startup);
  startup.StartupInfo.cb = sizeof startup;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.lpAttributeList = attributes;

  /*
   * CreateProcessW with bInheritHandles: the only inheritable handles in this process are the
   * three standard handles libuv gave it. EXTENDED_STARTUPINFO_PRESENT carries the job list.
   * The environment (NULL) is this process's, without the two MOSS_JOB_* variables.
   */
  PROCESS_INFORMATION process;
  SecureZeroMemory(&process, sizeof process);
  if (!CreateProcessW(application, commandLine, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT,
                      NULL, NULL, &startup.StartupInfo, &process)) {
    DWORD error = GetLastError();
    /* This Windows refuses the job list itself: the launcher cannot contain anything here. */
    if (error == ERROR_INVALID_PARAMETER || error == ERROR_NOT_SUPPORTED) {
      return fail(MOSS_JOB_LAUNCH_EXIT_JOB_REFUSED, "CreateProcess inside the job", error);
    }
    return fail(MOSS_JOB_LAUNCH_EXIT_CREATE_PROCESS, "CreateProcess", error);
  }
  /* CloseHandle: the thread handle is not needed; the process handle is waited on. */
  CloseHandle(process.hThread);

  /* WaitForSingleObject: returns when the program itself exits. */
  if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) {
    return fail(MOSS_JOB_LAUNCH_EXIT_WAIT, "WaitForSingleObject", GetLastError());
  }
  /* GetExitCodeProcess: the program's code becomes the launcher's own. */
  DWORD exitCode = 0;
  if (!GetExitCodeProcess(process.hProcess, &exitCode)) {
    return fail(MOSS_JOB_LAUNCH_EXIT_WAIT, "GetExitCodeProcess", GetLastError());
  }
  /*
   * Returning ends this process, which closes the job's only handle: Windows ends whatever the
   * program left running. Nothing is closed by hand, so no step can be skipped.
   */
  return exitCode;
}

/* Entry point without the C runtime: ExitProcess with run's code. */
void __stdcall mossJobLaunchEntry(void) { ExitProcess(run()); }
