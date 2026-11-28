import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("keep_backrest_status", pathlib.Path(__file__).with_name("keep-backrest-status.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackrestStatusTest(unittest.TestCase):
    def test_snapshot_view_omits_paths_and_does_not_invent_health(self):
        result = module.snapshot_view([{"id": "abc", "time": "2026-11-24T03:00:00Z", "tags": ["plan:daily"], "paths": ["private-path"]}])
        self.assertNotIn("private-path", json.dumps(result))
        self.assertEqual(result["plans"][0]["snapshots"], 1)
        self.assertIsNone(result["plans"][0]["success"])


if __name__ == "__main__":
    unittest.main()
