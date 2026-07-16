import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "timelapse.py"
SPEC = importlib.util.spec_from_file_location("drawio_timelapse", MODULE_PATH)
TIMELAPSE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TIMELAPSE)


class TimelapseHtmlTest(unittest.TestCase):
    def test_build_html_escapes_untrusted_title(self):
        title = '<img src=x onerror="alert(1)"> & project'
        frames = [(b"png", "abcdef123456", "2026-07-10", "subject", 1, 0)]

        document = TIMELAPSE.build_html(frames, title)

        self.assertNotIn(title, document)
        escaped = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; project"
        self.assertEqual(2, document.count(escaped))


if __name__ == "__main__":
    unittest.main()
