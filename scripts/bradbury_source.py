"""Write contracts/aid_pledge.bradbury.py from contracts/aid_pledge.py.

Bradbury testnet (Phase 2) runs a newer py-genlayer runner, named in the first lines of the file, and stores the
contract's source on-chain when it is deployed (about 0.77M gas per KB; a block holds about 32M gas). So the Bradbury
file is the same program with the Bradbury header, keeping only the Bradbury branch of the import-time `if hasattr(genlayer,
"gl")` block, without comments and docstrings and with one-space indentation: the code is otherwise unchanged (the
module's syntax tree is compared below, with that block resolved the same way), and the direct tests run on this file.

    python3 scripts/bradbury_source.py           # write it
    python3 scripts/bradbury_source.py --check   # fail if it is out of date (CI)
"""

import ast
import io
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC, OUT = ROOT / "contracts/aid_pledge.py", ROOT / "contracts/aid_pledge.bradbury.py"
STUDIO = '# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }\n'
BRADBURY = '# v0.3.0\n# { "Depends": "py-genlayer:babwp9t37jw9g4j2bccgn14g6x7x9s1f7dsmh7emvz735pz4zxa0" }\n'
MAX_BYTES = 37 * 1024  # measured 2026-11-09: 38.0 KB deploys (31.9M gas), 38.6 KB exceeds the block gas limit


def _docstring_lines(tree: ast.AST) -> set:
    lines = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                lines.update(range(first.lineno, first.end_lineno + 1))
    return lines


def strip(code: str) -> str:
    """Drop comments, docstrings and blank lines, and indent with one space per level; keep every statement.
    Continuation lines (inside brackets) keep a single space of indentation; a block whose only statement was a
    docstring gets `pass`, decided on whole logical lines."""
    doc = _docstring_lines(ast.parse(code))
    drop = {}  # line -> column where a trailing comment starts
    inside = set()  # lines inside a multi-line string literal: kept exactly, blank ones included
    opened = []
    starts, ends = {}, {}  # logical lines: first physical line -> its indentation, last physical line -> first line
    first = None
    for tok in tokenize.generate_tokens(io.StringIO(code).readline):
        if tok.type == tokenize.COMMENT:
            drop[tok.start[0]] = tok.start[1]
        elif tok.type == tokenize.STRING and tok.end[0] > tok.start[0]:
            inside.update(range(tok.start[0] + 1, tok.end[0] + 1))
        elif tok.type == getattr(tokenize, "FSTRING_START", -1):
            opened.append(tok.start[0])
        elif tok.type == getattr(tokenize, "FSTRING_END", -1) and opened:
            start = opened.pop()
            inside.update(range(start + 1, tok.end[0] + 1))
        if tok.type in (tokenize.NEWLINE, tokenize.NL, tokenize.INDENT, tokenize.DEDENT, tokenize.COMMENT, tokenize.ENCODING):
            if tok.type == tokenize.NEWLINE and first is not None:
                ends[tok.start[0]] = first
                first = None
            continue
        if first is None:
            first = tok.start[0]
            starts[first] = tok.start[1]
    out, raw, last_of = [], [], []  # last_of[i]: the logical line ending on this output line started at that line
    for n, line in enumerate(code.splitlines(), start=1):
        if n in doc:
            continue
        if n in inside:
            out.append(line)
            raw.append(True)
            last_of.append(None)
            continue
        if n in drop:
            line = line[:drop[n]].rstrip()
        if line.strip():
            if n in starts:
                out.append(" " * (starts[n] // 4) + line.lstrip(" "))  # one space per indentation level
            else:
                out.append(" " + line.lstrip(" "))  # inside brackets indentation does not matter
            raw.append(False)
            last_of.append(ends.get(n))
    fixed = []
    for i, line in enumerate(out):
        fixed.append(line)
        if not raw[i] and last_of[i] is not None and line.rstrip().endswith(":"):
            indent = starts[last_of[i]] // 4
            nxt = next((out[j] for j in range(i + 1, len(out)) if out[j].strip()), "")
            if not nxt or len(nxt) - len(nxt.lstrip()) <= indent:
                fixed.append(" " * (indent + 1) + "pass")
    return "\n".join(fixed) + "\n"


def _shape(code: str) -> str:
    """The syntax tree without docstrings: equal shapes mean the same program."""
    tree = ast.parse(code)
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if isinstance(body, list) and body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
                and isinstance(body[0].value.value, str):
            node.body = body[1:] or [ast.Pass()]
    return ast.dump(tree, include_attributes=False)


def _is_compat(node) -> bool:
    return (isinstance(node, ast.If) and isinstance(node.test, ast.Call) and getattr(node.test.func, "id", "") == "hasattr"
            and len(node.test.args) == 2 and getattr(node.test.args[0], "id", "") == "genlayer")


def bradbury_branch(code: str) -> str:
    """Replace the compat block with its else branch (dedented): the Bradbury runner always takes it."""
    tree = ast.parse(code)
    node = next(n for n in tree.body if _is_compat(n))
    lines = code.splitlines(keepends=True)
    else_start = node.orelse[0].lineno - 1
    body = [ln[4:] if ln.startswith("    ") else ln for ln in lines[else_start:node.end_lineno]]
    return "".join(lines[:node.lineno - 1] + body + lines[node.end_lineno:])


def _resolved(code: str) -> str:
    """The syntax tree with the compat block replaced by its else branch, for comparison."""
    tree = ast.parse(code)
    out = []
    for n in tree.body:
        out.extend(n.orelse if _is_compat(n) else [n])
    tree.body = out
    return ast.unparse(tree)


def build() -> str:
    code = SRC.read_text()
    if not code.startswith(STUDIO):
        raise SystemExit("contracts/aid_pledge.py must start with the Studio header")
    body = strip(bradbury_branch(code[len(STUDIO):]))
    if _shape(body) != _shape(_resolved(code)):
        raise SystemExit("stripping changed the program")
    out = BRADBURY + body
    if len(out.encode()) > MAX_BYTES:
        raise SystemExit(f"Bradbury source is {len(out.encode())} bytes; keep it under {MAX_BYTES}")
    return out


if __name__ == "__main__":
    out = build()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != out:
            raise SystemExit("contracts/aid_pledge.bradbury.py is out of date: run python3 scripts/bradbury_source.py")
        print("contracts/aid_pledge.bradbury.py is up to date")
    else:
        OUT.write_text(out)
        print(f"wrote contracts/aid_pledge.bradbury.py ({len(out.encode())} bytes)")
