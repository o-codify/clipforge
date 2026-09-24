"""Run the complete Windows media process tree inside enforced OS limits."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
import subprocess
import sys
import time


class BasicLimits(c.Structure):
    _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64),
                ('flags', w.DWORD), ('min_ws', c.c_size_t), ('max_ws', c.c_size_t),
                ('active', w.DWORD), ('affinity', c.c_size_t),
                ('priority', w.DWORD), ('scheduling', w.DWORD)]


class Limits(c.Structure):
    _fields_ = [('basic', BasicLimits), ('io', c.c_uint64 * 6),
                ('process_memory', c.c_size_t), ('job_memory', c.c_size_t),
                ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]


class CpuLimits(c.Structure):
    _fields_ = [('flags', w.DWORD), ('rate', w.DWORD)]


class Startup(c.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR),
                ('title', w.LPWSTR), ('x', w.DWORD), ('y', w.DWORD),
                ('width', w.DWORD), ('height', w.DWORD), ('cols', w.DWORD),
                ('rows', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
                ('show', w.WORD), ('reserved_size', w.WORD), ('reserved_ptr', c.c_void_p),
                ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE)]


class ProcessInfo(c.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE),
                ('pid', w.DWORD), ('tid', w.DWORD)]


class MemoryStatus(c.Structure):
    _fields_ = [('length', w.DWORD), ('load', w.DWORD), ('total', c.c_uint64),
                ('available', c.c_uint64), ('total_page', c.c_uint64), ('available_page', c.c_uint64),
                ('total_virtual', c.c_uint64), ('available_virtual', c.c_uint64), ('extended', c.c_uint64)]


def wait_for_headroom(min_free_mb):
    if not min_free_mb:
        return
    kernel = c.WinDLL('kernel32', use_last_error=True)
    status = MemoryStatus()
    status.length = c.sizeof(status)
    while True:
        if not kernel.GlobalMemoryStatusEx(c.byref(status)):
            raise c.WinError(c.get_last_error())
        if status.available >= min_free_mb * 1024 * 1024:
            return
        print(f'Media waits for {min_free_mb} MiB free RAM', flush=True)
        time.sleep(30)


def run(command, memory_mb, cpu_percent):
    if os.name != 'nt':
        raise RuntimeError('This launcher requires Windows Job Objects')
    if not 128 <= memory_mb <= 32768 or not 1 <= cpu_percent <= 100:
        raise ValueError('Invalid media resource limits')
    kernel = c.WinDLL('kernel32', use_last_error=True)
    signatures = {
        'CreateJobObjectW': ([c.c_void_p, w.LPCWSTR], w.HANDLE),
        'SetInformationJobObject': ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
        'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
        'CreateProcessW': ([w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL,
                           w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(Startup), c.POINTER(ProcessInfo)], w.BOOL),
        'ResumeThread': ([w.HANDLE], w.DWORD),
        'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),
        'GetExitCodeProcess': ([w.HANDLE, c.POINTER(w.DWORD)], w.BOOL),
        'TerminateProcess': ([w.HANDLE, w.UINT], w.BOOL),
        'CloseHandle': ([w.HANDLE], w.BOOL),
    }
    for name, (args, result) in signatures.items():
        getattr(kernel, name).argtypes, getattr(kernel, name).restype = args, result

    def check(ok):
        if not ok:
            raise c.WinError(c.get_last_error())
        return ok

    job = check(kernel.CreateJobObjectW(None, None))
    process = ProcessInfo()
    try:
        limits = Limits()
        # Aggregate committed memory, lower scheduling priority, and kill the
        # whole tree when the launcher exits. Children cannot break away.
        limits.basic.flags = 0x200 | 0x20 | 0x2000
        limits.basic.priority = 0x4000  # BELOW_NORMAL_PRIORITY_CLASS
        limits.job_memory = memory_mb * 1024 * 1024
        check(kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)))
        cpu = CpuLimits(0x1 | 0x4, cpu_percent * 100)  # ENABLE | HARD_CAP
        check(kernel.SetInformationJobObject(job, 15, c.byref(cpu), c.sizeof(cpu)))
        startup = Startup()
        startup.cb = c.sizeof(startup)
        check(kernel.CreateProcessW(None, c.create_unicode_buffer(subprocess.list2cmdline(command)),
              None, None, False, 0x4 | 0x08000000, None, None, c.byref(startup), c.byref(process)))
        # No child code executes before the limits are installed.
        check(kernel.AssignProcessToJobObject(job, process.process))
        if kernel.ResumeThread(process.thread) == 0xFFFFFFFF:
            raise c.WinError(c.get_last_error())
        print(f'Media tree limited: {memory_mb} MiB RAM, {cpu_percent}% CPU', flush=True)
        kernel.WaitForSingleObject(process.process, 0xFFFFFFFF)
        code = w.DWORD()
        check(kernel.GetExitCodeProcess(process.process, c.byref(code)))
        return code.value
    finally:
        if process.process:
            kernel.TerminateProcess(process.process, 1)
            kernel.CloseHandle(process.process)
        if process.thread:
            kernel.CloseHandle(process.thread)
        kernel.CloseHandle(job)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--memory-mb', type=int, default=4096)
    parser.add_argument('--cpu-percent', type=int, default=20)
    parser.add_argument('--min-free-mb', type=int, default=0)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('A media command is required')
    wait_for_headroom(args.min_free_mb)
    sys.exit(run(command, args.memory_mb, args.cpu_percent))
