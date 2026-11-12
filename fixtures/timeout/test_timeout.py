import unittest

from timeout import timeout


class TimeoutTest(unittest.TestCase):
    def test_zero_is_a_valid_timeout(self):
        self.assertEqual(timeout({"timeout": 0}), 0)

    def test_missing_uses_default(self):
        self.assertEqual(timeout({}), 1000)

    def test_none_uses_default(self):
        self.assertEqual(timeout({"timeout": None}), 1000)
