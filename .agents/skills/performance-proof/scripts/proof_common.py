"""Small stdlib contracts shared by this package's command line tools."""
import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time


class ProofError(Exception):
    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ProofError(message)


def require(condition, message, code=2):
    if not condition:
        raise ProofError(message, code)


def absolute(value):
    path = Path(value)
    require(path.is_absolute(), f"absolute path required: {value}")
    return path.resolve()


def inside(path, root):
    path, root = absolute(path), absolute(root)
    require(path.is_relative_to(root), f"path escapes root: {path}")
    return path


def load(path):
    try:
        return json.loads(absolute(path).read_text(), parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
    except (OSError, ValueError) as exc:
        raise ProofError(f"cannot read JSON {path}: {exc}") from exc


def validate(value, schema, definitions=None, at="$"):
    """Validate the deliberately small JSON Schema subset used in schema.json."""
    definitions = definitions or schema.get("$defs", {})
    if "$ref" in schema:
        return validate(value, definitions[schema["$ref"].split("/")[-1]], definitions, at)
    types = schema.get("type", [])
    types = [types] if isinstance(types, str) else types
    matches = {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "integer": type(value) is int,
        "number": type(value) in (int, float) and math.isfinite(value),
        "null": value is None,
    }
    require(not types or any(matches.get(t, False) for t in types), f"{at}: expected {types}")
    if "const" in schema:
        require(value == schema["const"], f"{at}: expected {schema['const']!r}")
    if "enum" in schema:
        require(value in schema["enum"], f"{at}: not in {schema['enum']}")
    if isinstance(value, dict):
        require(all(k in value for k in schema.get("required", [])), f"{at}: missing required field")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            require(not (set(value) - set(props)), f"{at}: unknown fields {set(value) - set(props)}")
        for key, item in value.items():
            child = props.get(key, schema.get("additionalProperties", {}))
            if isinstance(child, dict):
                validate(item, child, definitions, f"{at}.{key}")
    if isinstance(value, list):
        require(len(value) >= schema.get("minItems", 0), f"{at}: too few items")
        for i, item in enumerate(value):
            validate(item, schema.get("items", {}), definitions, f"{at}[{i}]")
    if isinstance(value, str):
        require(len(value) >= schema.get("minLength", 0), f"{at}: empty string")
        require(not schema.get("pattern") or re.search(schema["pattern"], value), f"{at}: pattern mismatch")
    if type(value) in (int, float):
        require("minimum" not in schema or value >= schema["minimum"], f"{at}: below minimum")
        require("maximum" not in schema or value <= schema["maximum"], f"{at}: above maximum")


def artifact(path):
    path = absolute(path)
    require(path.is_file(), f"artifact is not a file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return {"path": str(path), "sha256": digest.hexdigest(), "bytes": path.stat().st_size}


def verify(record):
    require(isinstance(record, dict) and set(record) == {"path", "sha256", "bytes"}, "bad artifact record")
    try:
        current = artifact(record["path"])
    except (ProofError, OSError) as exc:
        raise ProofError(f"artifact missing/unreadable: {record['path']}", 3) from exc
    require(current == record, f"artifact changed: {record['path']}", 3)


@contextlib.contextmanager
def lock(state, seconds=2):
    """Atomic mkdir lock works across processes; never steal another process's lock."""
    directory = Path(str(state) + ".lock")
    deadline = time.monotonic() + seconds
    while True:
        try:
            directory.mkdir(mode=0o700)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise ProofError(f"state locked: {directory}; inspect a crashed writer before manual recovery", 4)
            time.sleep(0.025)
    try:
        yield
    finally:
        directory.rmdir()


def atomic(path, data):
    path = absolute(path)
    require(path.parent.is_dir(), f"parent does not exist: {path.parent}")
    fd, name = tempfile.mkstemp(prefix=".proof-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def emit(data):
    print(json.dumps(data, indent=2, allow_nan=False))
