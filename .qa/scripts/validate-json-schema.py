import json
import pathlib
import sys

from jsonschema import Draft202012Validator


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: validate-json-schema.py <schema.json> <document.json>", file=sys.stderr)
        return 2
    schema_path = pathlib.Path(sys.argv[1])
    document_path = pathlib.Path(sys.argv[2])
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    document = json.loads(document_path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    errors = sorted(Draft202012Validator(schema).iter_errors(document), key=lambda error: list(error.path))
    if errors:
        for error in errors:
            location = ".".join(str(part) for part in error.absolute_path) or "<root>"
            print(f"{location}: {error.message}", file=sys.stderr)
        return 1
    print(f"valid: {document_path.name} against {schema_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
