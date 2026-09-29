"""Real Windows sharing conflicts must not terminate the media governor."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from media_resources import atomic_json


class StateTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows file sharing semantics')
    def test_reader_lock_preserves_snapshot_and_recovers(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'resources.json'
            self.assertTrue(atomic_json(file, {'at': 1}))
            # Allow reads/writes, deny deletion/replacement as ordinary readers can.
            handle = kernel.CreateFileW(str(file), 0x80000000, 3, None, 3, 0, None)
            self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
            try:
                self.assertFalse(atomic_json(file, {'at': 2}))
                self.assertEqual(json.loads(file.read_text()), {'at': 1})
            finally:
                kernel.CloseHandle(handle)
            self.assertTrue(atomic_json(file, {'at': 3}))
            self.assertEqual(json.loads(file.read_text()), {'at': 3})
            handle = kernel.CreateFileW(str(file), 0x80000000, 3, None, 3, 0, None)
            def unlock():
                time.sleep(.04)
                kernel.CloseHandle(handle)
            thread = threading.Thread(target=unlock)
            thread.start()
            try:
                self.assertTrue(atomic_json(file, {'at': 4}))
                self.assertEqual(json.loads(file.read_text()), {'at': 4})
            finally:
                thread.join()

    def test_unrelated_io_errors_are_not_hidden(self):
        with tempfile.TemporaryDirectory() as directory, patch('media_resources.os.replace', side_effect=OSError('disk failed')):
            with self.assertRaisesRegex(OSError, 'disk failed'):
                atomic_json(Path(directory) / 'resources.json', {})


if __name__ == '__main__':
    unittest.main()
