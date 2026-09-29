"""Real Windows suspension/release; only our temporary process tree is touched."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import psutil
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts'))
from media_resources import Monitor, Policy


@unittest.skipUnless(os.name=='nt' and shutil.which('node'), 'Windows desktop only')
class DesktopTest(unittest.TestCase):
    def test_resource_pressure_suspends_heavy_children_but_activity_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            script=folder/'controller.cjs'
            script.write_text("""const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.argv[2],['-c',"import pathlib,time,sys; p=pathlib.Path(sys.argv[1]);\\nwhile True: p.write_text(str(time.time())); time.sleep(.03)",process.argv[3]+'/heavy'],{windowsHide:true,stdio:'ignore'});
fs.writeFileSync(process.argv[3]+'/pid',String(child.pid));
setInterval(()=>fs.writeFileSync(process.argv[3]+'/heartbeat',String(Date.now())),50);
""",encoding='utf-8')
            controller=subprocess.Popen(['node',str(script),sys.executable,str(folder)],creationflags=0x08000000)
            monitor=None
            try:
                deadline=time.monotonic()+5
                while not (folder/'heavy').exists() and time.monotonic()<deadline:time.sleep(.05)
                self.assertTrue((folder/'heavy').exists())
                monitor=Monitor(controller.pid,folder/'state.json',Policy(resume_seconds=0))
                # Simulate competing CPU work without generating real load.
                monitor.last_gpu=time.monotonic()+60
                with patch('media_resources.idle_seconds',return_value=0), \
                     patch.object(monitor.psutil,'cpu_percent',return_value=99), \
                     patch.object(monitor.psutil,'virtual_memory',return_value=SimpleNamespace(total=32*2**30,available=16*2**30)):
                    state=monitor.tick()
                self.assertEqual(state['reason'],'cpu-pressure')
                self.assertTrue(monitor.suspended)
                time.sleep(.15)
                heavy=(folder/'heavy').read_text();beat=(folder/'heartbeat').read_text()
                time.sleep(.2)
                self.assertEqual(heavy,(folder/'heavy').read_text())
                self.assertNotEqual(beat,(folder/'heartbeat').read_text())
                # The host may currently be short of RAM; this is a test of
                # real suspend/resume, with available headroom as an input.
                with patch('media_resources.idle_seconds',return_value=0), \
                     patch.object(monitor.psutil,'cpu_percent',return_value=5), \
                     patch.object(monitor.psutil,'virtual_memory',return_value=SimpleNamespace(total=32*2**30,available=16*2**30)):
                    state=monitor.tick()
                self.assertFalse(state['paused'])
                time.sleep(.15)
                self.assertNotEqual(heavy,(folder/'heavy').read_text())
                monitor.pause_since=time.monotonic()-6
                with patch('media_resources.idle_seconds',return_value=0), \
                     patch.object(monitor.psutil,'virtual_memory',return_value=SimpleNamespace(total=32*2**30,available=1*2**30)):
                    state=monitor.tick()
                self.assertEqual(state['reason'],'memory-pressure')
                self.assertTrue(state['preempted'])
                self.assertIsNone(controller.poll())
                for pid in state['preempted']:
                    try:psutil.Process(int(pid)).wait(timeout=3)
                    except psutil.NoSuchProcess:pass
            finally:
                if monitor:monitor.close()
                if controller.poll() is None:
                    for p in psutil.Process(controller.pid).children(recursive=True):
                        try:p.kill()
                        except psutil.NoSuchProcess:pass
                    controller.kill()
                controller.wait()

    def test_child_is_inside_native_job_with_cpu_and_memory_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            script=folder/'query.py';result=folder/'result.json'
            script.write_text('''import ctypes as c,importlib.util,json,sys,time
s=importlib.util.spec_from_file_location('limiter',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
k=c.WinDLL('kernel32',use_last_error=True)
k.QueryInformationJobObject.argtypes=[c.c_void_p,c.c_int,c.c_void_p,c.c_uint,c.c_void_p]
cpu=m.CpuLimits(); limits=m.Limits()
assert k.QueryInformationJobObject(None,15,c.byref(cpu),c.sizeof(cpu),None)
assert k.QueryInformationJobObject(None,9,c.byref(limits),c.sizeof(limits),None)
open(sys.argv[2],'w').write(json.dumps({'cpuFlags':cpu.flags,'cpuRate':cpu.rate,'memory':limits.job_memory,'flags':limits.basic.flags}))
time.sleep(.8)
''',encoding='utf-8')
            # The venv redirector is a second Python process. Use the base
            # executable so the query is the controller, not a suspended child.
            run=subprocess.run([sys._base_executable,str(ROOT/'scripts/run-media-limited.py'),'--idle-seconds','0','--state-file',str(folder/'state.json'),'--',sys._base_executable,str(script),str(ROOT/'scripts/run-media-limited.py'),str(result)],env={**os.environ,'PYTHONPATH':str(ROOT/'scripts')+os.pathsep+str(ROOT/'.venv/Lib/site-packages')},capture_output=True,timeout=15)
            self.assertEqual(run.returncode,0,run.stderr.decode(errors='replace'))
            data=json.loads(result.read_text())
            self.assertEqual(data['cpuFlags']&5,5)
            self.assertLessEqual(data['cpuRate'],9000)
            self.assertGreater(data['memory'],256*2**20)
            self.assertEqual(data['flags']&0x2200,0x2200)

if __name__=='__main__':unittest.main()
