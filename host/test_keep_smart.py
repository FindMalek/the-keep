import importlib.machinery
import importlib.util
import pathlib
import unittest

path = str(pathlib.Path(__file__).with_name("keep-smart.py"))
loader = importlib.machinery.SourceFileLoader("keep_smart", path)
spec = importlib.util.spec_from_loader("keep_smart", loader)
keep_smart = importlib.util.module_from_spec(spec)
loader.exec_module(keep_smart)


class Labelled(unittest.TestCase):
    def test_reads_numbers_with_thousands_separators(self):
        out = "Power On Hours:                     1,234\nData Units Written:                 12,345,678 [6.32 TB]"
        self.assertEqual(keep_smart.labelled(out, "Power On Hours"), 1234)
        self.assertEqual(keep_smart.labelled(out, "Data Units Written"), 12345678)


if __name__ == "__main__":
    unittest.main()
