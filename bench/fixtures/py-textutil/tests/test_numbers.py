import unittest

from textutil.numbers import clamp


class NumbersTest(unittest.TestCase):
    def test_clamp(self):
        self.assertEqual(clamp(5, 0, 3), 3)
        self.assertEqual(clamp(-1, 0, 3), 0)
        self.assertEqual(clamp(2, 0, 3), 2)


if __name__ == "__main__":
    unittest.main()
