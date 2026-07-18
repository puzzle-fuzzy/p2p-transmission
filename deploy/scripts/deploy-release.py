#!/usr/bin/env python3
"""Immutable version entry for the fixed, root-owned deployment control plane."""

from __future__ import annotations

import sys
from pathlib import Path


# The production wrapper starts Python in isolated mode through the atomically
# selected ``current`` version. Resolve this entry to its immutable physical
# directory once so every imported module comes from the same bundle.
HELPER_ROOT = Path(__file__).resolve().parent
PACKAGE_ROOT = (HELPER_ROOT / "deploy_control_plane").resolve(strict=True)
if PACKAGE_ROOT.name != "deploy_control_plane":
    raise SystemExit("fixed deployment control-plane package path is invalid")
package_parent_text = str(PACKAGE_ROOT.parent)
if not sys.path or sys.path[0] != package_parent_text:
    sys.path.insert(0, package_parent_text)

from deploy_control_plane.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
