#!/usr/bin/env python3
"""
DreamHost API bridge for the DreamDeploy VS Code extension.

Reads a JSON request from stdin, calls the python-dreamhostapi library,
and writes a JSON response to stdout.

Request schema:
  { "key": "<api_key>", "cmd": "<module>-<method>", "params": { ... } }

Response schema (success):
  { "result": "success", "data": <returned_data> }

Response schema (error):
  { "result": "error", "data": "<error_message>" }
"""

import sys
import json

try:
    from dreamhostapi import DreamHostAPI
    from dreamhostapi.exceptions import APIError
except ImportError:
    print(json.dumps({
        "result": "error",
        "data": (
            "The 'dreamhostapi' package is not installed. "
            "Run: pip install -r scripts/requirements.txt"
        )
    }))
    sys.exit(1)


def main() -> None:
    try:
        request = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"result": "error", "data": f"Invalid JSON input: {exc}"}))
        sys.exit(1)

    api_key: str = request.get("key", "")
    cmd: str = request.get("cmd", "")
    params: dict = request.get("params", {})

    if not api_key:
        print(json.dumps({"result": "error", "data": "Missing API key"}))
        sys.exit(1)

    # cmd is in the form "module-method", e.g. "domain-add_domain"
    parts = cmd.split("-", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        print(json.dumps({"result": "error", "data": f"Invalid command format: '{cmd}'. Expected '<module>-<method>'."}))
        sys.exit(1)

    module_name, method_name = parts

    try:
        api = DreamHostAPI(api_key)
        module = getattr(api, module_name)
        method = getattr(module, method_name)
        result = method(**params)
        print(json.dumps({"result": "success", "data": result}))
    except APIError as exc:
        print(json.dumps({"result": "error", "data": str(exc)}))
        sys.exit(1)
    except AttributeError:
        print(json.dumps({"result": "error", "data": f"Unknown API command: '{cmd}'"}))
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"result": "error", "data": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
