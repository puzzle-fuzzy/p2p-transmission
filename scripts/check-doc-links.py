"""Check relative Markdown links in the repository documentation."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
DOCUMENTS = (
    Path("README.md"),
    Path("docs/user-guide.md"),
    Path("apps/web/README.md"),
    Path("services/api/README.md"),
    Path("deploy/README.md"),
)
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
INLINE_CODE_RE = re.compile(r"(`+)[^`\n]*\1")
LINK_RE = re.compile(
    r"(?<!!)\[[^\]\n]+\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))"
    r"(?:\s+[^)\n]*)?\)"
)


def document_lines(text: str):
    """Yield (line number, line) for Markdown lines outside fenced code blocks."""

    fence_char: str | None = None
    fence_length = 0
    for line_number, line in enumerate(text.splitlines(), start=1):
        fence = FENCE_RE.match(line)
        if fence_char is None:
            if fence:
                marker = fence.group(1)
                fence_char = marker[0]
                fence_length = len(marker)
                continue
            yield line_number, INLINE_CODE_RE.sub("", line)
            continue

        if fence and fence.group(1)[0] == fence_char and len(fence.group(1)) >= fence_length:
            fence_char = None
            fence_length = 0


def is_external(target: str) -> bool:
    parsed = urlsplit(target)
    return target.startswith(("#", "//")) or bool(parsed.scheme or parsed.netloc)


def check_document(path: Path) -> tuple[int, list[str]]:
    issues: list[str] = []
    checked = 0
    source = ROOT / path
    if not source.is_file():
        return checked, [f"{path}: 文档不存在"]

    text = source.read_text(encoding="utf-8")
    for line_number, line in document_lines(text):
        for match in LINK_RE.finditer(line):
            target = match.group(1) or match.group(2)
            if not target or is_external(target):
                continue

            parsed = urlsplit(target)
            relative_target = unquote(parsed.path)
            if not relative_target:
                continue

            checked += 1
            candidate = (source.parent / relative_target).resolve()
            try:
                candidate.relative_to(ROOT)
            except ValueError:
                issues.append(
                    f"{path}:{line_number}: 链接越出仓库: {target} -> {candidate}"
                )
                continue

            if not candidate.exists():
                issues.append(
                    f"{path}:{line_number}: 链接目标不存在: {target} -> "
                    f"{candidate.relative_to(ROOT)}"
                )

    return checked, issues


def main() -> int:
    total_checked = 0
    issues: list[str] = []
    for document in DOCUMENTS:
        checked, document_issues = check_document(document)
        total_checked += checked
        issues.extend(document_issues)

    if issues:
        print("Markdown 链接检查失败：")
        for issue in issues:
            print(f"- {issue}")
        return 1

    print(f"Markdown 链接检查通过：检查 {total_checked} 个仓库内相对链接。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
