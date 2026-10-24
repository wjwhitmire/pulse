"""Repository rule: two vendor names may appear in no tracked file (code, tests, docs, built pages).

The names are kept as the first 16 hex digits of the SHA-256 of each lower-case word, so this file
does not hold them. Every run of letters in every tracked text file is checked; there are no
exemptions."""

import hashlib
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BANNED = {"c857d09db23e6822", "c70eca6b0f88f44d"}


def digest(word):
    return hashlib.sha256(word.lower().encode("utf-8")).hexdigest()[:16]


def tracked_files():
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode("utf-8")
        return [ROOT / p for p in out.split("\0") if p]
    except (OSError, subprocess.CalledProcessError):
        skip = {".git", "__pycache__", ".pytest_cache", "node_modules"}
        return [p for p in ROOT.rglob("*") if p.is_file() and not skip & set(p.relative_to(ROOT).parts) and ".egg-info" not in str(p)]


def test_the_digests_are_for_the_two_names():
    # a self-check that the digest list still holds two different words
    assert len(BANNED) == 2 and all(re.fullmatch(r"[0-9a-f]{16}", d) for d in BANNED)


def test_no_tracked_file_names_them():
    found = []
    for p in tracked_files():
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        words = set(re.findall(r"[a-z]+", text.lower()))
        if any(digest(w) in BANNED for w in words):
            found.append(str(p.relative_to(ROOT)))
    assert found == [], found
