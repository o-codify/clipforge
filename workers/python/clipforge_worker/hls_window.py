"""Select complete, unencrypted VOD segments without changing their source clock."""
import math
import re
from urllib.parse import urljoin


def manifest_window(text, base_url, start, end):
    if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end):
        raise ValueError('Invalid source window')
    if '#EXT-X-ENDLIST' not in text:
        raise ValueError('Only completed VODs can be selected')
    # Do not guess encryption IVs, byte offsets, or changing codec timestamps.
    maps = set()
    for line in text.splitlines():
        if line.startswith(('#EXT-X-BYTERANGE', '#EXT-X-DISCONTINUITY')):
            raise ValueError('Unsupported segmented source')
        if line.startswith('#EXT-X-MAP:'):
            match = re.fullmatch(r'#EXT-X-MAP:URI="([^"]+)"', line.strip())
            if not match:
                raise ValueError('Unsupported initialization fragment')
            maps.add(urljoin(base_url, match[1]))
        if line.startswith('#EXT-X-KEY:') and 'METHOD=NONE' not in line:
            raise ValueError('Encrypted source is not supported')
    if len(maps) > 1:
        raise ValueError('Changing video initialization is not supported')
    current, duration, sequence, index = 0.0, None, 0, 0
    selected = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('#EXT-X-MEDIA-SEQUENCE:'):
            sequence = int(line.split(':', 1)[1])
        elif line.startswith('#EXTINF:'):
            duration = float(line.split(':', 1)[1].split(',')[0])
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError('Invalid segment duration')
        elif line and not line.startswith('#'):
            if duration is None:
                raise ValueError('Expected a media playlist')
            if current < end and current + duration > start:
                selected.append((index, current, duration, urljoin(base_url, line)))
            current += duration
            index += 1
            duration = None
    if not selected or current < end - .1:
        raise ValueError('The recording does not cover the requested window')
    header = ['#EXTM3U', '#EXT-X-VERSION:7' if maps else '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
              f'#EXT-X-TARGETDURATION:{math.ceil(max(x[2] for x in selected))}',
              f'#EXT-X-MEDIA-SEQUENCE:{sequence + selected[0][0]}']
    if maps:
        header.append(f'#EXT-X-MAP:URI="{next(iter(maps))}"')
    for _, _, seconds, url in selected:
        header.extend([f'#EXTINF:{seconds},', url])
    header.append('#EXT-X-ENDLIST')
    return '\n'.join(header) + '\n', selected[0][1], sum(x[2] for x in selected)
