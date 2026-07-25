import ast
import json
import os
import shlex
import subprocess
import sys
import tomllib
import venv
import zipfile
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).parents[1]
PACKAGE_ROOT = PROJECT_ROOT / "src" / "cc_patch"
FORBIDDEN_PATH_PARTS = ("../../lib/patch", "lib/patch/", "cli.mjs")
FORBIDDEN_RUNNER_PARTS = ("js-vector-runner", "javascript-runner", "js_runner")
JAVASCRIPT_EXECUTABLES = {"bun", "node", "nodejs", "deno"}
SUBPROCESS_CALLS = {"call", "check_call", "check_output", "Popen", "run"}
ASYNCIO_PROCESS_CALLS = {"create_subprocess_exec", "create_subprocess_shell"}
OS_PROCESS_CALLS = {
    "execl",
    "execle",
    "execlp",
    "execlpe",
    "execv",
    "execve",
    "execvp",
    "execvpe",
    "popen",
    "spawnl",
    "spawnle",
    "spawnlp",
    "spawnlpe",
    "spawnv",
    "spawnve",
    "spawnvp",
    "spawnvpe",
    "system",
}


def _literal_strings(node: ast.AST) -> set[str]:
    return {
        child.value
        for child in ast.walk(node)
        if isinstance(child, ast.Constant) and isinstance(child.value, str)
    }


def _is_forbidden_reference(value: str) -> bool:
    normalized = value.replace("\\", "/").lower()
    path_parts = normalized.split("/")
    return (
        "../../lib/patch" in normalized
        or "lib/patch/" in normalized
        or normalized == "lib.patch"
        or normalized.startswith("lib.patch.")
        or "cli.mjs" in path_parts
        or any(part in normalized for part in FORBIDDEN_RUNNER_PARTS)
    )


def _command_parts(values: set[str]) -> set[str]:
    parts: set[str] = set()
    for value in values:
        try:
            tokens = shlex.split(value)
        except ValueError:
            tokens = value.split()
        parts.update(Path(token).name for token in tokens)
    return parts


def _scan_python_boundary(package_root: Path) -> list[str]:
    violations: list[str] = []
    for source_path in sorted(package_root.rglob("*.py")):
        source = source_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(source_path))
        relative_path = source_path.relative_to(package_root)
        subprocess_modules = {"subprocess"}
        subprocess_functions: set[str] = set()
        process_modules = {"asyncio": ASYNCIO_PROCESS_CALLS, "os": OS_PROCESS_CALLS}
        process_module_aliases: dict[str, set[str]] = {}
        process_functions: set[str] = set()
        importlib_modules = {"importlib"}
        import_module_functions: set[str] = set()

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                subprocess_modules.update(
                    alias.asname or alias.name
                    for alias in node.names
                    if alias.name == "subprocess"
                )
                importlib_modules.update(alias.asname or alias.name for alias in node.names if alias.name == "importlib")
                for module_name, calls in process_modules.items():
                    for alias in node.names:
                        if alias.name == module_name:
                            process_module_aliases[alias.asname or alias.name] = calls
            elif isinstance(node, ast.ImportFrom):
                if node.module == "subprocess":
                    subprocess_functions.update(
                        alias.asname or alias.name
                        for alias in node.names
                        if alias.name in SUBPROCESS_CALLS
                    )
                elif node.module == "importlib":
                    import_module_functions.update(
                        alias.asname or alias.name
                        for alias in node.names
                        if alias.name == "import_module"
                    )
                elif node.module in process_modules:
                    process_functions.update(
                        alias.asname or alias.name
                        for alias in node.names
                        if alias.name in process_modules[node.module]
                    )

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                imported_names = [node.module or ""]
            else:
                imported_names = []
            for imported_name in imported_names:
                if imported_name == "lib.patch" or imported_name.startswith("lib.patch."):
                    violations.append(f"{relative_path}:{node.lineno}: forbidden import {imported_name}")

            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if _is_forbidden_reference(node.value):
                    violations.append(f"{relative_path}:{node.lineno}: forbidden JavaScript path {node.value!r}")

            if not isinstance(node, ast.Call):
                continue
            function = node.func
            is_dynamic_import = (
                isinstance(function, ast.Name)
                and function.id in {"__import__", *import_module_functions}
            ) or (
                isinstance(function, ast.Attribute)
                and isinstance(function.value, ast.Name)
                and function.value.id in importlib_modules
                and function.attr == "import_module"
            )
            if is_dynamic_import and any(
                value == "lib.patch" or value.startswith("lib.patch.")
                for value in _literal_strings(node)
            ):
                violations.append(f"{relative_path}:{node.lineno}: forbidden dynamic import lib.patch")

            is_subprocess_attribute = (
                isinstance(function, ast.Attribute)
                and isinstance(function.value, ast.Name)
                and function.value.id in subprocess_modules
                and function.attr in SUBPROCESS_CALLS
            )
            is_imported_subprocess_function = isinstance(function, ast.Name) and function.id in subprocess_functions
            is_process_attribute = (
                isinstance(function, ast.Attribute)
                and isinstance(function.value, ast.Name)
                and function.value.id in process_module_aliases
                and function.attr in process_module_aliases[function.value.id]
            )
            is_imported_process_function = isinstance(function, ast.Name) and function.id in process_functions
            if not (
                is_subprocess_attribute
                or is_imported_subprocess_function
                or is_process_attribute
                or is_imported_process_function
            ):
                continue
            command_strings = {value.replace("\\", "/").lower() for value in _literal_strings(node)}
            command_parts = _command_parts(command_strings)
            invokes_javascript = bool(command_parts & JAVASCRIPT_EXECUTABLES)
            references_javascript_core = any(_is_forbidden_reference(value) for value in command_strings)
            if invokes_javascript or references_javascript_core:
                violations.append(f"{relative_path}:{node.lineno}: process invokes JavaScript/Bun core")

    return violations


def test_pyproject_exposes_ccpatch_entrypoint() -> None:
    with (PROJECT_ROOT / "pyproject.toml").open("rb") as pyproject_file:
        pyproject = tomllib.load(pyproject_file)

    assert pyproject["project"]["scripts"]["ccpatch"] == "cc_patch.cli:main_entry"


def test_wheel_embeds_platform_matrix_and_fresh_install_can_patch_and_revert(
    tmp_path: Path,
    make_bundle,
) -> None:
    dist = tmp_path / "dist"
    built = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(dist), str(PROJECT_ROOT)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert built.returncode == 0, built.stderr
    wheel = next(dist.glob("cc_patch-*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
    assert "cc_patch/data/platform-writes-v1.json" in names

    environment = tmp_path / "venv"
    venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    installed = subprocess.run(
        [str(python), "-m", "pip", "install", "--no-deps", str(wheel)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert installed.returncode == 0, installed.stderr

    binary = tmp_path / "claude"
    clean = bytes(make_bundle())
    binary.write_bytes(clean)
    store = tmp_path / "store"
    env = {**os.environ, "UNBUN_CC_STORE": str(store)}
    commands = [
        [str(python), "-m", "cc_patch", "--binary", str(binary), "--json"],
        [str(python), "-m", "cc_patch", "patch", "--binary", str(binary), "--feature", "agent-model", "--json"],
        [str(python), "-m", "cc_patch", "revert", "--binary", str(binary), "--feature", "agent-model", "--json"],
    ]
    outputs = [
        subprocess.run(command, text=True, capture_output=True, check=False, env=env)
        for command in commands
    ]

    assert [result.returncode for result in outputs] == [0, 0, 0], [
        result.stderr for result in outputs
    ]
    assert all(json.loads(result.stdout) is not None for result in outputs)
    assert binary.read_bytes() == clean


def test_python_package_does_not_depend_on_javascript_implementation() -> None:
    assert _scan_python_boundary(PACKAGE_ROOT) == []


@pytest.mark.parametrize(
    "source",
    [
        "from lib.patch import channels\n",
        "CORE = '../../lib/patch/channels.mjs'\n",
        "CLI = 'cli.mjs'\n",
        "RUNNER = 'test/contract/js-vector-runner.mjs'\n",
        "import subprocess\nsubprocess.run(['bun', 'cli.mjs', 'cc'])\n",
        "import subprocess as sp\nsp.Popen(['node', 'javascript-runner.mjs'])\n",
        "from subprocess import run as execute\nexecute('bun cli.mjs cc', shell=True)\n",
        "import importlib\nimportlib.import_module('lib.patch.channels')\n",
        "import importlib.util as iu\niu.find_spec('lib.patch.channels')\n",
        "__import__('lib.patch.channels')\n",
        "import asyncio as aio\naio.create_subprocess_exec('bun', 'feature.mjs')\n",
        "from os import execvp\nexecvp('node', ['node', 'feature.mjs'])\n",
    ],
)
def test_boundary_scanner_rejects_javascript_dependencies(tmp_path: Path, source: str) -> None:
    package_root = tmp_path / "cc_patch"
    package_root.mkdir()
    (package_root / "violation.py").write_text(source, encoding="utf-8")

    assert _scan_python_boundary(package_root)


def test_boundary_scanner_allows_platform_subprocesses(tmp_path: Path) -> None:
    package_root = tmp_path / "cc_patch"
    package_root.mkdir()
    (package_root / "platform.py").write_text(
        "import asyncio\n"
        "import os\n"
        "import subprocess\n"
        "asyncio.create_subprocess_exec('/usr/bin/codesign', '-s', '-', '/tmp/claude')\n"
        "os.system('uname -s')\n"
        "subprocess.run(['/usr/bin/codesign', '-s', '-', '/tmp/claude'])\n"
        "subprocess.check_output(['uname', '-s'])\n",
        encoding="utf-8",
    )

    assert _scan_python_boundary(package_root) == []