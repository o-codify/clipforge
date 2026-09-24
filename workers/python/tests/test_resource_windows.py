import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from clipforge_worker import speech


class SpeechWindowsTest(unittest.TestCase):
    def test_interruption_resumes_completed_windows_and_keeps_timestamps(self):
        with tempfile.TemporaryDirectory() as root:
            audio = Path(root) / 'source.m4a'
            audio.write_bytes(b'test source identity')
            initial = speech.Transcript('ru', 302, [speech.Segment(10, 11, 'first', [speech.Word(10, 11, 'first')])])
            # The second window starts at 298: overlap word at 299.5 must be
            # discarded, and the new word must use its original VOD time 301.
            resumed = speech.Transcript('ru', 52, [speech.Segment(1, 4, 'old new',
                       [speech.Word(1, 2, 'old'), speech.Word(3, 4, 'new')])])
            options = dict(engine=object(), batch_size=1)
            with patch.dict(os.environ, {'SPEECH_WINDOW_SECONDS': '300'}), \
                 patch.object(speech.subprocess, 'check_output', return_value='350'), \
                 patch.object(speech.subprocess, 'run'), \
                 patch.object(speech, '_transcribe_window', side_effect=[initial, RuntimeError('interrupted')]):
                with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                    speech.transcribe(audio, **options)
            with patch.dict(os.environ, {'SPEECH_WINDOW_SECONDS': '300'}), \
                 patch.object(speech.subprocess, 'check_output', return_value='350'), \
                 patch.object(speech.subprocess, 'run'), \
                 patch.object(speech, '_transcribe_window', return_value=resumed) as decode:
                result = speech.transcribe(audio, **options)
                self.assertEqual(decode.call_count, 1)
                self.assertEqual([(w.text, w.start) for w in result.words], [('first', 10), ('new', 301)])
                self.assertEqual(result.duration, 350)
                speech.transcribe(audio, **options)
                self.assertEqual(decode.call_count, 1, 'Completed windows must be reused')
                audio.write_bytes(b'new source with different size')
                speech.transcribe(audio, **options)
                self.assertEqual(decode.call_count, 3, 'Changed sources must invalidate checkpoints')


if __name__ == '__main__':
    unittest.main()
