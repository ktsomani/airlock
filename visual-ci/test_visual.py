import base64
import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import subprocess
from unittest.mock import patch

from PIL import Image

from compare import VIEWPORTS, build_report, capture, compare
from comment import format_comment


def shot(key, color, *, clipped=False, text="Merge"):
    png = io.BytesIO()
    Image.new("RGB", (VIEWPORTS[key], 5), color).save(png, format="PNG")
    return {
        "key": key, "png": base64.b64encode(png.getvalue()).decode(),
        "element": {"exists": True, "clipped": clipped, "text": text},
    }


class VisualReviewTests(unittest.TestCase):
    def test_changes_and_size_deltas_are_red(self):
        old = Image.new("RGB", (2, 1), "white")
        new = Image.new("RGB", (3, 1), "white")
        new.putpixel((0, 0), (0, 0, 0))
        image, changed, total = compare(old, new)
        self.assertEqual((changed, total), (2, 3))
        self.assertEqual(image.getpixel((0, 0)), (221, 30, 49))
        self.assertEqual(image.getpixel((2, 0)), (221, 30, 49))

    def test_timeout_forcibly_removes_the_named_container(self):
        completed = subprocess.CompletedProcess([], 0, b"", b"")
        with patch("compare.subprocess.run", side_effect=[subprocess.TimeoutExpired("docker", 120), completed]) as run:
            with self.assertRaisesRegex(RuntimeError, "120 seconds"):
                capture("example", Path("."))
            launch, cleanup = run.call_args_list
            args = launch.args[0]
            self.assertEqual(launch.kwargs["timeout"], 120)
            self.assertEqual(cleanup.args[0], ["docker", "rm", "-f", args[args.index("--name") + 1]])

    def test_report_names_only_changed_viewports(self):
        before = [shot(key, "white") for key in VIEWPORTS]
        after = [shot(key, "white") for key in VIEWPORTS]
        after[0] = shot("mobile", "black", clipped=True, text="Merge <drafts>")
        with TemporaryDirectory() as tmp:
            report = build_report(before, after, Path(tmp))
            self.assertEqual(len(list(Path(tmp).glob("*.png"))), 9)
        message = format_comment(report, "https://example.com/report", "a" * 40)
        self.assertIn("Mobile (390px)", message)
        self.assertIn("Merge button now clips", message)
        self.assertIn("Merge &lt;drafts&gt;", message)
        self.assertNotIn("Tablet", message)
        self.assertNotIn("Desktop", message)


if __name__ == "__main__":
    unittest.main()
