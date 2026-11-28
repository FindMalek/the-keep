import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("keep_n8n_status", pathlib.Path(__file__).with_name("keep-n8n-status.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class N8nStatusTest(unittest.TestCase):
    def test_workflow_view_excludes_credentials_and_parameters(self):
        workflow = {"id": "1", "name": "test", "active": True,
                    "nodes": [{"name": "start", "type": "trigger", "position": [1, 2], "parameters": {"secret": "hidden"}, "credentials": {"token": "hidden"}}],
                    "connections": {"start": {"main": [None, [{"node": "next"}]]}}}
        result = module.workflow_view(workflow)
        self.assertNotIn("hidden", json.dumps(result))
        self.assertEqual(result["edges"], [{"from": "start", "to": "next"}])


if __name__ == "__main__":
    unittest.main()
