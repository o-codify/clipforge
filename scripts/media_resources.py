"""Desktop media governor. The controller/DB connection are never suspended.

Only Python/FFmpeg/download descendants in our Job Object are preemptible.
All thresholds are fractions of the actual machine, not fixed RAM quotas.
"""
from dataclasses import dataclass
import ctypes
import json
import math
import os
from pathlib import Path
import subprocess
import time


@dataclass
class Policy:
    target: float = 90
    # Optional idle-only mode. Normal desktop use is governed by available
    # resources, regardless of keyboard/mouse activity.
    idle_seconds: float = 0
    resume_seconds: float = 15
    min_free_mb: float = 1536
    download_kbps: float = 10000
    upload_kbps: float = 5000
    link_down_kbps: float = 20000
    link_up_kbps: float = 10000

    def __post_init__(self):
        for key, value in vars(self).items():
            if not math.isfinite(value) or value < 0:
                raise ValueError(f'Invalid resource setting: {key}')
        if not 1 <= self.target <= 90 or min(self.download_kbps, self.upload_kbps, self.link_down_kbps, self.link_up_kbps) < 100:
            raise ValueError('Invalid CPU target or network capacity')

    def decide(self, s):
        reserve = max(self.min_free_mb, s['totalMb'] * (1 - self.target / 100))
        other_cpu = max(0, s['cpu'] - s['ownCpu'])
        reason = ('user-active' if s['idleSeconds'] < self.idle_seconds else
                  'memory-pressure' if s['freeMb'] < reserve else
                  'cpu-pressure' if other_cpu >= self.target - 3 else
                  'gpu-memory-pressure' if s.get('gpuFreeRatio', 1) < .1 else
                  'gpu-busy' if s.get('gpu', 0) >= self.target else None)
        return dict(paused=reason is not None, reason=reason,
                    cpuPercent=max(1, min(self.target, self.target - other_cpu - 3)) if reason is None else 1,
                    # A lower commit ceiling cannot reclaim existing memory.
                    # Leave controller allocation room while children suspend;
                    # their allocations are released by preemption below.
                    memoryMb=max(s['ownMemoryMb']+256, s['ownMemoryMb'] + s['freeMb'] - reserve), reserveMb=reserve,
                    downloadKbps=max(100, min(self.download_kbps, self.link_down_kbps * .85 - s.get('rxKbps', 0))),
                    uploadKbps=max(100, min(self.upload_kbps, self.link_up_kbps * .85 - s.get('txKbps', 0))))


def idle_seconds():
    class LastInput(ctypes.Structure):
        _fields_ = [('size', ctypes.c_uint), ('tick', ctypes.c_uint)]
    info = LastInput(ctypes.sizeof(LastInput), 0)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0  # Conservatively pauses only an explicitly selected idle-only mode.
    return ((ctypes.windll.kernel32.GetTickCount() - info.tick) & 0xffffffff) / 1000


def atomic_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    # Windows readers can briefly open the destination without FILE_SHARE_DELETE.
    # Keep the previous complete snapshot until replacement succeeds; never
    # truncate it in place or tear down the whole worker for a sharing violation.
    for attempt in range(6):
        try:
            os.replace(temporary, file)
            return True
        except OSError as error:
            if getattr(error, 'winerror', None) not in (5, 32, 33):
                raise
            if attempt < 5:
                time.sleep(.02 * (attempt + 1))
    # The next monitor tick retries. Consumers pause on a stale snapshot, while
    # the governor still applies CPU/memory limits and suspends heavy children.
    return False


class Monitor:
    def __init__(self, pid, state_file, policy=None):
        import psutil
        self.psutil = psutil
        self.root = psutil.Process(pid)
        self.file = state_file
        self.policy = policy or Policy()
        self.processes = {}
        self.suspended = {}
        self.preempted = {}
        self.good_since = None
        self.pause_since = None
        self.previous_net = psutil.net_io_counters(pernic=True)
        self.last_tick = time.monotonic()
        self.last_gpu = 0
        self.gpu = {}
        psutil.cpu_percent()

    def tick(self):
        p = self.psutil
        now = time.monotonic()
        live = {x.pid: self.processes.get(x.pid, x) for x in [self.root, *self.root.children(recursive=True)]}
        self.processes = live
        own_cpu = own_memory = 0
        heavy = []
        for process in live.values():
            try:
                own_cpu += process.cpu_percent() / (p.cpu_count() or 1)
                memory = process.memory_info()
                own_memory += getattr(memory, 'private', memory.rss) / 2**20
                if process.pid != self.root.pid and process.name().lower() in ('python.exe', 'pythonw.exe', 'ffmpeg.exe', 'yt-dlp.exe', 'deep-filter.exe', 'ollama.exe', 'ollama_llama_server.exe'):
                    heavy.append(process)
                    process.nice(p.BELOW_NORMAL_PRIORITY_CLASS)
                    process.ionice(p.IOPRIO_VERYLOW)
            except (p.NoSuchProcess, p.AccessDenied):
                pass
        memory = p.virtual_memory()
        counters = p.net_io_counters(pernic=True)
        # Do not double-count the same packets on VPN/virtual adapters.
        deltas = [(max(0, v.bytes_recv-self.previous_net[k].bytes_recv), max(0, v.bytes_sent-self.previous_net[k].bytes_sent))
                  for k, v in counters.items() if k in self.previous_net and 'loopback' not in k.lower()]
        dt = max(.1, now-self.last_tick)
        rx = max((x[0] for x in deltas), default=0)*8/1000/dt
        tx = max((x[1] for x in deltas), default=0)*8/1000/dt
        self.previous_net, self.last_tick = counters, now
        if now-self.last_gpu > 5:
            self.last_gpu = now
            try:
                raw = subprocess.check_output(['nvidia-smi', '--query-gpu=utilization.gpu,memory.free,memory.total', '--format=csv,noheader,nounits'],
                                              creationflags=0x08000000, timeout=2, stderr=subprocess.DEVNULL, text=True)
                rows = [[float(v) for v in row.split(',')] for row in raw.strip().splitlines()]
                self.gpu = dict(gpu=max(row[0] for row in rows), gpuFreeRatio=min(row[1]/row[2] for row in rows))
            except (OSError, ValueError, subprocess.SubprocessError):
                self.gpu = {}  # CPU-only machines do not need nvidia-smi.
        snapshot = dict(totalMb=memory.total/2**20, freeMb=memory.available/2**20, cpu=p.cpu_percent(),
                        ownCpu=own_cpu, ownMemoryMb=own_memory, idleSeconds=idle_seconds(), rxKbps=rx, txKbps=tx, **self.gpu)
        decision = self.policy.decide(snapshot)
        if decision['paused']:
            self.good_since = None
        elif self.good_since is None:
            self.good_since = now
        # A GPU kernel cannot be hard-capped like CPU time. Short duty-cycle
        # pauses lower average use; never discard a model just because its own
        # inference used the GPU. Foreground/RAM pauses have longer hysteresis.
        settling = 1 if getattr(self, 'last_reason', None) == 'gpu-busy' else self.policy.resume_seconds
        if not decision['paused'] and now-self.good_since < settling:
            decision.update(paused=True, reason='settling', cpuPercent=1)
        if decision['reason'] != 'settling':
            self.last_reason = decision['reason']
        if decision['paused']:
            self.pause_since = self.pause_since or now
        else:
            self.pause_since = None
        # Pausing alone retains RAM/VRAM. Release heavy children if pressure
        # persists, or after a minute of foreground activity. Node retries the
        # stage using checkpoints; it keeps the queue lease and heartbeats.
        release = decision['paused'] and self.pause_since is not None and now-self.pause_since >= (5 if decision['reason'] in ('memory-pressure', 'gpu-memory-pressure') else 60)
        for process in heavy:
            try:
                if release:
                    self.preempted[str(process.pid)] = time.time()*1000
                elif decision['paused'] and process.pid not in self.suspended:
                    process.suspend()
                    self.suspended[process.pid] = process
                elif not decision['paused'] and process.pid in self.suspended:
                    process.resume()
                    del self.suspended[process.pid]
            except (p.NoSuchProcess, p.AccessDenied):
                pass
        self.preempted = {pid: at for pid, at in self.preempted.items() if time.time()*1000-at < 24*3600*1000}
        state = dict(version=1, at=time.time()*1000, **decision, metrics=snapshot, preempted=self.preempted)
        published = atomic_json(self.file, state)  # Publish the retry reason BEFORE killing.
        if release and published:
            for process in heavy:
                try:
                    process.kill()
                    self.suspended.pop(process.pid, None)
                except (p.NoSuchProcess, p.AccessDenied):
                    pass
        return state

    def close(self):
        for process in self.suspended.values():
            try:
                process.resume()
            except (self.psutil.NoSuchProcess, self.psutil.AccessDenied):
                pass
        atomic_json(self.file, dict(version=1, at=time.time()*1000, paused=True, reason='governor-offline', preempted=self.preempted))
