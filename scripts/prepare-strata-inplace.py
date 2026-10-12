"""Prepare an opt-in Strata installer using its existing GGUF expert reader.

This removes a redundant experts.bin copy, not model parameters or precision.
The upstream installer remains intact. Unknown source versions fail closed.
"""
import argparse
import hashlib
import json
from pathlib import Path

REVISION = "7695859aa13afb248bdb4d36f9b2e95707db079d"


def patch_source(source: str) -> str:
    replacements = [
        ("(MODELS[model][\"arena_gb\"] + 1 if low_ram and not q2_avx and not pack_bin else 0)",
         "(0 if family == 'coder' else (MODELS[model][\"arena_gb\"] + 1 if low_ram and not q2_avx and not pack_bin else 0))"),
        ('if low_ram and not (pack / "experts.bin").exists():',
         'if low_ram and family != "coder" and not (pack / "experts.bin").exists():'),
        ('ok(f"engine: {eng / EXE}")',
         'if family == "coder" and engine_ver < (0, 1, 43):\n'
         '        fail("LumaFlow in-place experts require Strata engine 0.1.43 or newer")\n'
         '    ok(f"engine: {eng / EXE}")\n'
         '    if family == "coder":\n'
         '        ok("LumaFlow: read Coder expert bytes directly from GGUF; no duplicate experts.bin")'),
    ]
    for old, new in replacements:
        if source.count(old) != 1:
            raise ValueError("Unsupported Strata setup source; no file was modified")
        source = source.replace(old, new, 1)
    compile(source, "setup-lumaflow.py", "exec")
    return source


def prepare(root: Path):
    revision = root / "lumaflow-revision.txt"
    if not revision.exists() or revision.read_text().strip() != REVISION:
        raise ValueError("Verify the pinned Strata revision before preparing the installer")
    source_file = root / "setup.py"
    source = source_file.read_text(encoding="utf8")
    # Verify the referenced source path really supports the mode the patch selects.
    engine = (root / "src/core/expert_source.cpp").read_text(encoding="utf8")
    if 'if (layout.native && !gguf_.empty() && !std::filesystem::exists(path))' not in engine:
        raise ValueError("GGUF expert source support is missing")
    output = root / "setup-lumaflow.py"
    result = patch_source(source)
    output.write_text(result, encoding="utf8", newline="\n")
    report = {"upstreamRevision": REVISION, "sourceSha256": hashlib.sha256(source_file.read_bytes()).hexdigest(),
              "patchedSha256": hashlib.sha256(output.read_bytes()).hexdigest(), "family": "coder",
              "weightsChanged": False, "duplicateExpertCopy": False, "minimumEngine": "0.1.43"}
    (root / "lumaflow-inplace.json").write_text(json.dumps(report, indent=2), encoding="utf8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.root), indent=2))
