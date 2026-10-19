"""Directory scanner for codeindex."""

import fnmatch
from dataclasses import dataclass
from pathlib import Path

from .config import Config
from .detector import UNIVERSAL_EXCLUDES


@dataclass
class ScanResult:
    """Result of scanning a directory."""

    path: Path
    files: list[Path]
    subdirs: list[Path]


def _build_language_extensions() -> dict[str, list[str]]:
    """Invert parser.py's extension→language maps into language→extensions.

    Derived rather than hand-maintained: a parallel list drifts. It already had
    — ".mjs" mapped to javascript in parser.py but was missing here, so .mjs
    files were detected as javascript and then never collected.
    """
    from codeindex.parser import get_all_extensions

    mapping: dict[str, list[str]] = {}
    for ext, lang in get_all_extensions().items():
        mapping.setdefault(lang, []).append(ext)

    # Detection samples at most 500 files, so a large repo can report
    # "typescript" without the sample ever hitting a .tsx file. Keep .tsx
    # reachable from either language so those files are still collected.
    for ext in mapping.get("tsx", []):
        if ext not in mapping.setdefault("typescript", []):
            mapping["typescript"].append(ext)
    return mapping


LANGUAGE_EXTENSIONS = _build_language_extensions()


def get_language_extensions(languages: list[str]) -> set[str]:
    """Get file extensions for specified languages."""
    extensions = set()
    for lang in languages:
        extensions.update(LANGUAGE_EXTENSIONS.get(lang, []))
    return extensions


def _compute_rel_path(path: Path, base_path: Path) -> str:
    """Compute normalized relative path string, falling back gracefully on Windows."""
    try:
        return str(path.relative_to(base_path)).replace("\\", "/")
    except ValueError:
        try:
            return str(path.resolve().relative_to(base_path.resolve())).replace("\\", "/")
        except ValueError:
            return str(path).replace("\\", "/")


def _matches_exclude_pattern(rel_path: str, path_str: str, pattern: str) -> bool:
    """Check if rel_path or path_str matches a single exclude pattern."""
    if fnmatch.fnmatch(rel_path, pattern) or fnmatch.fnmatch(path_str, pattern):
        return True
    if "**" not in pattern:
        return False
    if fnmatch.fnmatch(rel_path, pattern.replace("**", "*")):
        return True
    core = pattern.strip("*/")
    if core and core in rel_path.split("/"):
        return True
    if pattern.startswith("**/"):
        suffix = pattern[3:]
        if fnmatch.fnmatch(rel_path, suffix):
            return True
        if suffix.endswith("/**") and fnmatch.fnmatch(rel_path, suffix[:-3]):
            return True
    return False


def _split_keep_patterns(exclude_patterns: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Split `!`-prefixed keep patterns out of an exclude list.

    Returns (excludes, keeps, keep_prefixes) where keep_prefixes holds the
    wildcard-free leading directories of each keep pattern — a directory
    matching one of them is an ancestor of (or inside) a keep, so scanning
    must descend into it even when an exclude pattern matches.
    """
    excludes: list[str] = []
    keeps: list[str] = []
    prefixes: list[str] = []
    for p in exclude_patterns:
        if not p.startswith("!"):
            excludes.append(p)
            continue
        keep = p[1:]
        keeps.append(keep)
        concrete = keep.split("*", 1)[0].rstrip("/")
        if not concrete:
            # `!**/a/b/**` 这类以通配开头的 keep：取通配之间最长的字面量段作为锚定目录，
            # 目录剪枝据此放行 keep 的祖先链；全无字面量的 keep 只能靠文件级匹配。
            literals = [seg.strip("/") for seg in keep.split("*") if seg.strip("/")]
            concrete = literals[-1] if literals else ""
        if concrete:
            prefixes.append(concrete)
    return excludes, keeps, prefixes


def _dir_shelters_keep(dir_rel: str, keep_prefixes: list[str]) -> bool:
    """True when dir_rel is the directory itself or an ancestor of a keep pattern."""
    for prefix in keep_prefixes:
        if dir_rel == prefix or prefix.startswith(dir_rel + "/"):
            return True
    return False


def _has_universal_segment(rel_path: str) -> bool:
    """True when any path segment is a universal hygiene directory.

    node_modules/.git/dist 这类目录永不入索引：keep 模式（`!` 前缀）也不得保护它们——
    实测案例：包内 node_modules 里 cordis 自引用符号链接层层嵌套，keep 整包保护时
    目录遍历成环。"""
    return any(seg in UNIVERSAL_EXCLUDES for seg in rel_path.split("/"))


def should_exclude(path: Path, exclude_patterns: list[str], base_path: Path,
                   _split: tuple[list[str], list[str], list[str]] | None = None) -> bool:
    """Check if path matches any exclude pattern.

    Patterns prefixed with `!` are keeps: they win over project excludes, so a
    blanket exclude (e.g. `**/vendor/**`) can carve out exceptions — except for
    universal hygiene directories (node_modules 等), which no keep can protect.
    Directory recursion is prefix-aware: a directory that is an ancestor of a
    keep is never pruned, otherwise the files a keep protects would never be
    reached.
    """
    excludes, keeps, prefixes = _split if _split is not None else _split_keep_patterns(exclude_patterns)
    if not excludes and not keeps:
        return False
    rel_path = _compute_rel_path(path, base_path)
    path_str = str(path)
    is_dir = path.is_dir()
    if not _has_universal_segment(rel_path):
        if any(_matches_exclude_pattern(rel_path, path_str, k) for k in keeps):
            return False
        if is_dir and prefixes and _dir_shelters_keep(rel_path, prefixes):
            return False
    return any(_matches_exclude_pattern(rel_path, path_str, p) for p in excludes)


def scan_directory(
    path: Path,
    config: Config,
    base_path: Path | None = None,
    recursive: bool = True,
    *,
    split: tuple[list[str], list[str], list[str]] | None = None,
) -> ScanResult:
    """
    Scan a directory and return its contents.

    Args:
        path: Directory to scan
        config: Configuration object
        base_path: Base path for relative pattern matching
        recursive: Whether to scan subdirectories recursively

    Returns:
        ScanResult with files and subdirectories
    """
    if base_path is None:
        base_path = path

    files: list[Path] = []
    subdirs: list[Path] = []

    if not path.exists() or not path.is_dir():
        return ScanResult(path=path, files=[], subdirs=[])

    split = _split_keep_patterns(config.exclude)

    for item in sorted(path.iterdir()):
        # Skip excluded paths
        if should_exclude(item, config.exclude, base_path, split):
            continue

        if item.is_file():
            # Filter by language/extension using unified extension map
            if item.suffix in get_language_extensions(config.languages):
                files.append(item)
        elif item.is_dir() and recursive:
            # Recursively scan subdirectories
            sub_result = scan_directory(item, config, base_path, recursive, split=split)
            files.extend(sub_result.files)
            subdirs.extend(sub_result.subdirs)
            subdirs.append(item)  # Track the subdirectory itself

    return ScanResult(path=path, files=files, subdirs=subdirs)



