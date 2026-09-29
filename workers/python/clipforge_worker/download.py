"""yt-dlp's native downloader with the desktop's live bandwidth budget.

The heavy lane serializes media downloads, so this budget is aggregate.
External FFmpeg network downloads are deliberately not used.
"""
import json
import os
import time
from pathlib import Path
from yt_dlp import main
from yt_dlp.downloader.common import FileDownloader

_original = FileDownloader.slow_down


def slow_down(self, start_time, now, byte_counter):
    file = os.environ.get('MEDIA_RESOURCE_STATE')
    if not file:
        return _original(self, start_time, now, byte_counter)
    previous = getattr(self, '_media_counter', 0)
    left = byte_counter - previous if byte_counter >= previous else byte_counter
    self._media_counter = byte_counter
    while left > 0:
        try:
            state = json.loads(Path(file).read_text(encoding='utf-8'))
            if state['paused'] or time.time()*1000-state['at'] > 10000:
                time.sleep(.1)
                continue
            speed = min(self.params.get('ratelimit') or float('inf'), state['downloadKbps']*125)
            piece = min(left, speed*.1)
            time.sleep(piece/speed)
            left -= piece
        except (OSError, ValueError, KeyError):
            time.sleep(.1)


FileDownloader.slow_down = slow_down
if __name__ == '__main__':
    main()
