"""Linux worker supervisor: respect cgroup limits and yield media children.

No Docker socket, host PID namespace or privileged capabilities are needed.
The Node coordinator remains alive while expensive children are preempted.
"""
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import psutil


def read(root, name):
    try:
        return (Path(root) / name).read_text().strip()
    except OSError:
        return ''


def limits(root='/sys/fs/cgroup', host_memory=None, host_cpus=None):
    memory = host_memory or psutil.virtual_memory().total
    cpus = host_cpus or len(os.sched_getaffinity(0))
    raw = read(root, 'memory.max') or read(root, 'memory/memory.limit_in_bytes')
    if raw.isdigit() and int(raw) > 0:
        memory = min(memory, int(raw))
    raw = read(root, 'cpu.max').split()
    if len(raw) == 2 and raw[0] != 'max':
        cpus = min(cpus, int(raw[0]) / int(raw[1]))
    else:
        quota, period = read(root, 'cpu/cpu.cfs_quota_us'), read(root, 'cpu/cpu.cfs_period_us')
        if quota and period and int(quota) > 0:
            cpus = min(cpus, int(quota) / int(period))
    return memory, max(.1, cpus)


def memory_available(limit, host_available, root='/sys/fs/cgroup', host_memory=None):
    used = read(root, 'memory.current') or read(root, 'memory/memory.usage_in_bytes')
    stats = read(root, 'memory.stat') or read(root, 'memory/memory.stat')
    values = dict(line.split() for line in stats.splitlines() if len(line.split()) == 2)
    # Reading model weights leaves clean, active page-cache pages even when the
    # engine copied weights into anonymous memory. Linux can reclaim that cache;
    # treating it as resident model memory caused an endless load/kill loop.
    cache = values.get('file', values.get('total_cache'))
    if cache is not None:
        reclaimable = max(0, int(cache)
            - int(values.get('shmem', values.get('total_shmem', '0')))
            - int(values.get('file_mapped', values.get('total_mapped_file', '0')))
            - int(values.get('file_dirty', values.get('total_dirty', '0')))
            - int(values.get('file_writeback', values.get('total_writeback', '0'))))
    else:
        reclaimable = int(values.get('inactive_file', values.get('total_inactive_file', '0')))
    host_reserve = (host_memory or psutil.virtual_memory().total) * .1
    available = max(0, host_available - max(0, host_reserve - limit * .1))
    return min(available, max(0, limit - int(used) + reclaimable)) if used.isdigit() else available


def cpu_allowance(cpus, host_cpus, host_percent, own_cores, target=90):
    other = max(0, host_cpus * host_percent / 100 - own_cores)
    return max(0, min(cpus * target / 100, host_cpus * target / 100 - other))


def preempt_tree(process):
    # A killed Python parent cannot run its finally block. Stop its private
    # vision server/runners first so they never escape the governor as orphans.
    try:
        descendants = process.children(recursive=True)
    except psutil.Error:
        descendants = []
    for child in reversed(descendants):
        try: child.kill()
        except psutil.Error: pass
    try: process.kill()
    except psutil.Error: pass


def main():
    storage = Path(os.getenv('WORKER_STORAGE', '/storage'))
    for name in ('data', 'out', 'models'):
        (storage / name).mkdir(parents=True, exist_ok=True)
    # Small licensed model files ship with the image; a named volume caches them.
    catalog = os.getenv('WORKER_PROFILE') == 'catalog'
    if not catalog:
        shutil.copytree(Path(os.getenv('MEDIA_BUNDLE_ROOT', '/app')) / 'models', storage / 'models', dirs_exist_ok=True)
    memory, cpus = limits()
    reserve = max((32 if catalog else 256) * 1048576, memory * .1)
    if memory < (256 * 1048576 if catalog else 2 * 1024**3):
        raise RuntimeError('Insufficient container memory; use the connection command issued by the platform')
    state_file = storage / 'resources.json'
    env = dict(os.environ, MEDIA_RESOURCE_STATE=str(state_file),
               SPEECH_CPU_THREADS=str(max(1, math.floor(cpus * .9))),
               OMP_NUM_THREADS=str(max(1, math.floor(cpus * .9))),
               OPENBLAS_NUM_THREADS=str(max(1, math.floor(cpus * .9))))
    def snapshot(paused=False, reason=None, own=0, free=None, preempted=None):
        free = memory_available(memory, psutil.virtual_memory().available) if free is None else free
        value = dict(at=time.time()*1000, paused=paused, reason=reason,
                     cpuPercent=min(90, float(os.getenv('MEDIA_CPU_TARGET', '90'))),
                     memoryMb=max(0, own + free - reserve)/1048576,
                     reserveMb=reserve/1048576,
                     downloadKbps=float(os.getenv('MEDIA_DOWNLOAD_KBPS', '10000')),
                     uploadKbps=float(os.getenv('MEDIA_UPLOAD_KBPS', '5000')),
                     metrics=dict(totalMb=memory/1048576, freeMb=free/1048576, ownMemoryMb=own/1048576),
                     preempted=preempted or {})
        temporary = state_file.with_suffix('.tmp')
        temporary.write_text(json.dumps(value)); temporary.replace(state_file)
    snapshot()
    child = subprocess.Popen(['node', os.getenv('WORKER_ENTRY', 'apps/worker/dist/main.js')], env=env)
    root = psutil.Process(child.pid)
    root.nice(10)
    try:
        root.ionice(psutil.IOPRIO_CLASS_IDLE)
    except (OSError, psutil.Error):
        pass
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
        child.terminate()
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    suspended = {}; preempted = {}; pressured_at = None; known = {}
    previous_cpu = {}; previous_at = time.monotonic(); credit = 0
    target = min(90, max(10, float(os.getenv('MEDIA_CPU_TARGET', '90'))))
    host_cpus = psutil.cpu_count() or 1
    psutil.cpu_percent()
    try:
        while child.poll() is None:
            try: descendants = root.children(recursive=True)
            except psutil.NoSuchProcess: break
            own = 0; cpu = {}
            for p in [root, *descendants]:
                try:
                    known[p.pid] = p
                    own += p.memory_info().rss
                    times = p.cpu_times(); cpu[p.pid] = times.user + times.system
                except psutil.Error: pass
            tick = time.monotonic(); elapsed = max(.01, tick - previous_at)
            consumed = sum(max(0, value-previous_cpu.get(pid,value)) for pid,value in cpu.items())
            allowed = cpu_allowance(cpus, host_cpus, psutil.cpu_percent(), consumed/elapsed, target)
            credit = min(cpus*.25, max(-cpus*.5, credit+allowed*elapsed-consumed))
            cpu_pressure = credit < 0 or allowed < .05
            previous_at = tick; previous_cpu = cpu
            free = memory_available(memory, psutil.virtual_memory().available)
            pressure = free < reserve
            pressured_at = pressured_at or time.monotonic() if pressure else None
            preempted = {pid:at for pid,at in preempted.items() if time.time()*1000-at<3600000}
            snapshot(pressure or cpu_pressure, 'memory-pressure' if pressure else 'cpu-pressure' if cpu_pressure else None, own, free, preempted)
            for p in descendants:
                try:
                    heavy = p.name().lower().startswith(('python', 'ffmpeg', 'ffprobe', 'ollama', 'llama-server'))
                    if not heavy:
                        continue
                    p.nice(10)
                    if (pressure or cpu_pressure) and p.pid not in suspended:
                        p.suspend(); suspended[p.pid] = p
                    elif not pressure and not cpu_pressure and p.pid in suspended:
                        p.resume(); suspended.pop(p.pid, None)
                    if pressure and pressured_at and time.monotonic()-pressured_at > 5:
                        preempted[str(p.pid)] = time.time()*1000
                        snapshot(True, 'memory-pressure', own, free, preempted)
                        preempt_tree(p); suspended.pop(p.pid, None)
                except psutil.Error:
                    pass
            # Only media children yield. Node keeps queue leases and heartbeats alive.
            time.sleep(.25)
            if stopping:
                break
        if stopping:
            try: child.wait(timeout=30)
            except subprocess.TimeoutExpired: child.kill()
    finally:
        for p in suspended.values():
            try: p.resume()
            except psutil.Error: pass
        for p in known.values():
            try:
                if p.is_running(): p.kill()
            except psutil.Error: pass
        if child.poll() is None: child.kill()
        child.wait()
    return child.returncode


if __name__ == '__main__':
    sys.exit(main())
