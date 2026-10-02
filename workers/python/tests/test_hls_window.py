import unittest
from clipforge_worker.hls_window import manifest_window


class WindowTest(unittest.TestCase):
    def test_preserves_absolute_clock_and_only_downloads_overlapping_fragments(self):
        manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n' + ''.join(f'#EXTINF:10,\n{x}.ts\n' for x in range(6)) + '#EXT-X-ENDLIST\n'
        result, offset, duration = manifest_window(manifest, 'https://example.test/v/index.m3u8', 23, 41)
        self.assertEqual((offset, duration), (20, 30))
        self.assertIn('#EXT-X-MEDIA-SEQUENCE:44', result)
        self.assertIn('https://example.test/v/2.ts', result)
        self.assertNotIn('/1.ts', result)
        self.assertNotIn('/5.ts', result)

    def test_rejects_live_encrypted_and_missing_duration(self):
        for manifest in ['#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXT-X-ENDLIST', '#EXTM3U\nx.ts\n#EXT-X-ENDLIST']:
            with self.assertRaises(ValueError):
                manifest_window(manifest, 'https://example.test/', 0, 20)

    def test_keeps_twitch_fragmented_mp4_initialization(self):
        manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\na.m4s\n#EXTINF:10,\nb.m4s\n#EXT-X-ENDLIST'
        result, offset, _ = manifest_window(manifest, 'https://example.test/v/list', 11, 19)
        self.assertEqual(offset, 10)
        self.assertIn('#EXT-X-MAP:URI="https://example.test/v/init.mp4"', result)
        self.assertNotIn('/a.m4s', result)
