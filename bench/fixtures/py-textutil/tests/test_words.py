import unittest

from textutil import slugify, truncate, word_count


class WordsTest(unittest.TestCase):
    def test_word_count(self):
        self.assertEqual(word_count("a b  c"), 3)
        self.assertEqual(word_count(""), 0)

    def test_slugify(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("  --A  b-- "), "a-b")

    def test_truncate(self):
        self.assertEqual(truncate("hello", 10), "hello")
        self.assertEqual(truncate("hello world", 8), "hello...")
        self.assertEqual(len(truncate("x" * 50, 20)), 20)


if __name__ == "__main__":
    unittest.main()
