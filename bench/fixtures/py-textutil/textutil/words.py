import re


def word_count(text: str) -> int:
    """Number of whitespace-separated words."""
    return len(text.split())


def slugify(text: str) -> str:
    """Lowercase, replace runs of non-alphanumerics with a single dash, strip dashes."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower())
    return slug.strip("-")


def truncate(text: str, limit: int, suffix: str = "...") -> str:
    """Shorten text to at most `limit` characters, including the suffix."""
    if len(text) <= limit:
        return text
    return text[: limit - len(suffix)] + suffix
