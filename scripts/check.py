"""Run the local Python quality checks without making model API calls."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMMANDS = [
    ["ruff", "check", "src/arbor", "tests", "scripts"],
    ["ruff", "format", "--check", "src/arbor", "tests", "scripts"],
    ["mypy", "src/arbor"],
    ["pytest", "-q"],
]


def main():
    for command in COMMANDS:
        result = subprocess.run([sys.executable, "-m", *command], cwd=ROOT)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
