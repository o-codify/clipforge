"""Bounded Twitch VOD downloads through the same native bandwidth limiter."""
import argparse
import json
from pathlib import Path
from yt_dlp import YoutubeDL
from yt_dlp.downloader.hls import HlsFD
import download  # Installs the adaptive bandwidth limiter.
from hls_window import manifest_window


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--vod', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--start', type=float, required=True)
    p.add_argument('--end', type=float, required=True)
    p.add_argument('--height', type=int, default=720)
    p.add_argument('--rate-kbps', type=float, required=True)
    a = p.parse_args()
    target = Path(a.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    params = {'format': f'best[height<={a.height}][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]',
              'ratelimit': max(1, min(40000, a.rate_kbps))*125,
              'concurrent_fragment_downloads': 1, 'buffersize': 16384,
              'noresizebuffer': True, 'skip_unavailable_fragments': False,
              'quiet': True, 'noprogress': True, 'continuedl': True}
    with YoutubeDL(params) as ydl:
        info = ydl.extract_info(f'https://www.twitch.tv/videos/{a.vod.removeprefix("v")}', download=False)
        if not info or info.get('is_live') or 'm3u8' not in info.get('protocol', ''):
            raise ValueError('Completed Twitch HLS recording required')
        with ydl.urlopen(info['url']) as response:
            manifest, offset, duration = manifest_window(response.read().decode(), response.url, a.start, a.end)
        selected = dict(info, hls_media_playlist_data=manifest, duration=duration)
        # The URL remains the original manifest for resolution; no ffmpeg network access.
        if not HlsFD.can_download(manifest, selected):
            raise ValueError('Native HLS download is unavailable')
        if not HlsFD(ydl, params).download(str(target), selected)[0]:
            raise RuntimeError('Source download failed')
    target.with_suffix('.json').write_text(json.dumps({'offsetSeconds': offset, 'duration': duration}), encoding='utf-8')


if __name__ == '__main__':
    main()
