"""OS-enforced budgets installed in the PDF child before importing the parser."""
import os

MEMORY_BYTES = 512 * 1024 * 1024
CPU_SECONDS = 10
WALL_SECONDS = 15
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_PDF_PAGES = 50
MAX_STREAM_BYTES = 8 * 1024 * 1024
MAX_DECODED_BYTES = 32 * 1024 * 1024
MAX_TEXT_CHARS = 250_000
MAX_PAGE_TEXT_LENGTH = 50_000
MAX_TOTAL_TEXT_LENGTH = 350_000
MAX_TABLES_PER_PAGE = 10
MAX_TABLE_ROWS_PER_PAGE = 250
MAX_TOTAL_TABLE_ROWS = 2_000
MAX_TABLE_COLS = 16
MAX_CELL_CHARS = 1_000
MAX_TOTAL_TABLE_CELLS = 10_000
MAX_CANDIDATES = 500
MAX_WORKER_STDOUT_BYTES = 2 * 1024 * 1024


def set_process_limits() -> None:
    if os.name == "nt":
        _set_windows_limits()
    else:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS + 1))


def _set_windows_limits() -> None:
    import ctypes as c

    class Basic(c.Structure):
        _fields_ = [("process_time", c.c_int64), ("job_time", c.c_int64),
                    ("flags", c.c_uint32), ("min_working_set", c.c_size_t),
                    ("max_working_set", c.c_size_t), ("active_processes", c.c_uint32),
                    ("affinity", c.c_size_t), ("priority", c.c_uint32), ("scheduling", c.c_uint32)]

    class Extended(c.Structure):
        _fields_ = [("basic", Basic), ("io", c.c_uint64 * 6),
                    ("process_memory", c.c_size_t), ("job_memory", c.c_size_t),
                    ("peak_process_memory", c.c_size_t), ("peak_job_memory", c.c_size_t)]

    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [c.c_void_p, c.c_wchar_p]
    kernel.CreateJobObjectW.restype = c.c_void_p
    kernel.SetInformationJobObject.argtypes = [c.c_void_p, c.c_int, c.c_void_p, c.c_uint32]
    kernel.SetInformationJobObject.restype = c.c_int
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = c.c_void_p
    kernel.AssignProcessToJobObject.argtypes = [c.c_void_p, c.c_void_p]
    kernel.AssignProcessToJobObject.restype = c.c_int
    kernel.CloseHandle.argtypes = [c.c_void_p]
    kernel.CloseHandle.restype = c.c_int
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise OSError("Cannot create parser resource limits")
    limits = Extended()
    limits.basic.flags = 0x100 | 0x2  # JOB_OBJECT_LIMIT_PROCESS_MEMORY | PROCESS_TIME
    limits.basic.process_time = CPU_SECONDS * 10_000_000
    limits.process_memory = MEMORY_BYTES
    if not (kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits))
            and kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess())):
        kernel.CloseHandle(job)
        raise OSError("Cannot apply parser resource limits")
    # Keep the job handle alive until the worker exits; no other process is assigned.
