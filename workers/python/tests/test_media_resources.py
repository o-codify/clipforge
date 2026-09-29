import importlib.util
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'scripts'))
from media_resources import Policy, network_rates
from types import SimpleNamespace


class ResourcePolicyTest(unittest.TestCase):
    def setUp(self):
        self.snapshot=dict(totalMb=32000,freeMb=14000,ownMemoryMb=2000,cpu=70,ownCpu=60,idleSeconds=600)

    def test_spare_resources_can_be_used(self):
        result=Policy().decide(self.snapshot)
        self.assertFalse(result['paused'])
        self.assertGreater(result['cpuPercent'],70)
        self.assertGreater(result['memoryMb'],10000)
        self.assertGreaterEqual(result['reserveMb'],3200-1)

    def test_other_programs_take_priority(self):
        busy=Policy().decide({**self.snapshot,'cpu':85,'ownCpu':5})
        self.assertLess(busy['cpuPercent'],10)
        self.assertTrue(Policy().decide({**self.snapshot,'cpu':99,'ownCpu':1})['paused'])

    def test_activity_does_not_pause_work_with_available_resources(self):
        active=Policy().decide({**self.snapshot,'idleSeconds':0})
        idle=Policy().decide({**self.snapshot,'idleSeconds':600})
        self.assertFalse(active['paused'])
        self.assertEqual(active['cpuPercent'],idle['cpuPercent'])
        self.assertEqual(active['memoryMb'],idle['memoryMb'])

    def test_idle_only_mode_requires_explicit_selection(self):
        self.assertEqual(Policy(idle_seconds=120).decide({**self.snapshot,'idleSeconds':5})['reason'],'user-active')

    def test_memory_gpu_pressure_suspend_work(self):
        for change,reason in [({'freeMb':1200},'memory-pressure'),({'gpuFreeRatio':.04},'gpu-memory-pressure')]:
            result=Policy().decide({**self.snapshot,**change})
            self.assertTrue(result['paused']);self.assertEqual(result['reason'],reason)

    def test_busy_network_reduces_both_directions(self):
        free=Policy().decide(self.snapshot)
        busy=Policy().decide({**self.snapshot,'rxKbps':16000,'txKbps':8200})
        self.assertLess(busy['downloadKbps'],free['downloadKbps'])
        self.assertLess(busy['uploadKbps'],free['uploadKbps'])

    def test_local_tunnel_traffic_does_not_consume_internet_budget(self):
        previous={k:SimpleNamespace(bytes_recv=100,bytes_sent=100) for k in ['Wi-Fi','VPN','Loopback']}
        counters={'Wi-Fi':SimpleNamespace(bytes_recv=1100,bytes_sent=600),
                  'VPN':SimpleNamespace(bytes_recv=100000100,bytes_sent=100000100),
                  'Loopback':SimpleNamespace(bytes_recv=200000100,bytes_sent=200000100)}
        self.assertEqual(network_rates(previous,counters,1,{'Wi-Fi'}),(8,4))
        self.assertEqual(network_rates(previous,counters,1,None),(800000,800000))

    def test_network_counter_reset_is_not_negative_usage(self):
        previous={'Wi-Fi':SimpleNamespace(bytes_recv=2000,bytes_sent=2000)}
        counters={'Wi-Fi':SimpleNamespace(bytes_recv=100,bytes_sent=50)}
        self.assertEqual(network_rates(previous,counters,1,{'Wi-Fi'}),(0,0))


if __name__=='__main__':unittest.main()
