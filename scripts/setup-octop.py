#!/usr/bin/env python3
"""Compatibility entry point for the isolated Octop runtime setup."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path


RUNTIME = Path(__file__).with_name("octop-runtime.py")
sys.argv = [str(RUNTIME), "setup", *sys.argv[1:]]
runpy.run_path(str(RUNTIME), run_name="__main__")
