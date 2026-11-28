import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("keep_n8n_actions", pathlib.Path(__file__).with_name("keep-n8n-actions.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class N8nActionsTest(unittest.TestCase):
    def test_config_rejects_group_writable_and_symlink_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "config.json")
            with open(path, "w") as output:
                json.dump({"container": "n8n", "allowed": ["safe"]}, output)
            os.chmod(path, 0o600)
            self.assertIsNotNone(module.config(path, os.getuid()))
            os.symlink(path, os.path.join(directory, "link"))
            self.assertIsNone(module.config(os.path.join(directory, "link"), os.getuid()))
            os.chmod(path, 0o620)
            self.assertIsNone(module.config(path, os.getuid()))

    def test_only_allowlisted_ids_are_dispatched_without_a_shell(self):
        settings = {"container": "n8n", "allowed": ["safe"]}
        with patch.object(module.subprocess, "run") as run:
            run.return_value.returncode = 0
            self.assertEqual(module.dispatch("safe;reboot", settings), "refused")
            self.assertEqual(module.dispatch("other", settings), "refused")
            self.assertEqual(module.dispatch("safe", settings), "dispatched")
            self.assertEqual(run.call_args.args[0], ["docker", "exec", "-d", "n8n", "n8n", "execute", "--id=safe"])
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
