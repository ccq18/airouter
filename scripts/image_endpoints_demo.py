#!/usr/bin/env python3
"""Call Airouter's OpenAI-compatible image generation and edit endpoints.

Examples:
  python scripts/image_endpoints_demo.py
  python scripts/image_endpoints_demo.py --ak sk-airouter-xxxx
  python scripts/image_endpoints_demo.py --input-image /path/to/input.png --skip-generation
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


DEFAULT_BASE_URL = "http://127.0.0.1:3009"
DEFAULT_GENERATION_PROMPT = (
    "A tasteful illustrated portrait of an adult East Asian woman, elegant, "
    "dignified, fully clothed, neutral background, no text, no watermark."
)
DEFAULT_EDIT_PROMPT = (
    "Refine this into a polished tasteful portrait of an adult East Asian woman. "
    "Preserve the same person, pose, and composition. Improve soft studio "
    "lighting, facial realism, hair detail, and elegant fully clothed modern "
    "styling. Keep a clean neutral background. No nudity, no sexualized pose, "
    "no text, no watermark."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Test /v1/images/generations and /v1/images/edits through Airouter.",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Airouter base URL, default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument(
        "--api-key",
        "--ak",
        dest="api_key",
        default=os.environ.get("AIROUTER_API_KEY", ""),
        help="Optional Airouter entry API key. Also reads AIROUTER_API_KEY.",
    )
    parser.add_argument("--model", default="gpt-image-1.5")
    parser.add_argument("--output-format", default="png", choices=("png", "jpeg", "webp"))
    parser.add_argument("--size", default="", help="Optional generation size, for example 1024x1024.")
    parser.add_argument("--quality", default="", help="Optional generation quality, for example medium.")
    parser.add_argument("--prompt", default=DEFAULT_GENERATION_PROMPT)
    parser.add_argument("--edit-prompt", default=DEFAULT_EDIT_PROMPT)
    parser.add_argument(
        "--input-image",
        default="",
        help="Optional local image for /v1/images/edits. If omitted, the generated image is used.",
    )
    parser.add_argument(
        "--skip-generation",
        action="store_true",
        help="Only call /v1/images/edits. Requires --input-image.",
    )
    parser.add_argument(
        "--skip-edit",
        action="store_true",
        help="Only call /v1/images/generations.",
    )
    parser.add_argument(
        "--out-dir",
        default="/tmp/airouter-image-demo",
        help="Directory for JSON responses and decoded images.",
    )
    parser.add_argument("--timeout", type=float, default=330.0, help="HTTP timeout in seconds.")
    return parser.parse_args()


def auth_headers(api_key: str) -> dict[str, str]:
    if not api_key:
        return {}
    return {"Authorization": f"Bearer {api_key}"}


def url_join(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"


def request_bytes(
    url: str,
    *,
    method: str = "POST",
    headers: dict[str, str] | None = None,
    body: bytes,
    timeout: float,
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers=headers or {},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as err:
        error_body = err.read()
        raise RuntimeError(
            f"{method} {url} failed with HTTP {err.code}: {error_body.decode('utf-8', 'replace')[:2000]}"
        ) from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"{method} {url} failed: {err}") from err


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def decode_image_response(response_body: bytes, json_path: Path, image_path: Path) -> None:
    try:
        payload = json.loads(response_body.decode("utf-8"))
    except json.JSONDecodeError as err:
        json_path.write_bytes(response_body)
        raise RuntimeError(f"response is not JSON; saved raw body to {json_path}") from err

    write_json(json_path, payload)
    b64_json = ((payload.get("data") or [{}])[0] or {}).get("b64_json")
    if not b64_json:
        raise RuntimeError(f"response JSON does not contain data[0].b64_json; saved to {json_path}")

    image_path.write_bytes(base64.b64decode(b64_json))


def call_generation(args: argparse.Namespace, out_dir: Path) -> Path:
    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "output_format": args.output_format,
    }
    if args.size:
        payload["size"] = args.size
    if args.quality:
        payload["quality"] = args.quality

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        **auth_headers(args.api_key),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    status, _, response_body = request_bytes(
        url_join(args.base_url, "/v1/images/generations"),
        headers=headers,
        body=body,
        timeout=args.timeout,
    )

    image_path = out_dir / f"generation.{args.output_format}"
    json_path = out_dir / "generation-response.json"
    decode_image_response(response_body, json_path, image_path)
    print(f"generation: HTTP {status} -> {image_path}")
    print(f"generation JSON: {json_path}")
    return image_path


def multipart_body(fields: dict[str, str], files: dict[str, Path]) -> tuple[str, bytes]:
    boundary = f"airouter-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    for name, path in files.items():
        filename = path.name
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            (
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(path.read_bytes())
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return boundary, b"".join(chunks)


def call_edit(args: argparse.Namespace, out_dir: Path, input_image: Path) -> Path:
    if not input_image.is_file():
        raise RuntimeError(f"input image does not exist: {input_image}")

    fields = {
        "model": args.model,
        "prompt": args.edit_prompt,
        "output_format": args.output_format,
    }
    boundary, body = multipart_body(fields, {"image": input_image})
    headers = {
        **auth_headers(args.api_key),
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/json",
    }
    status, _, response_body = request_bytes(
        url_join(args.base_url, "/v1/images/edits"),
        headers=headers,
        body=body,
        timeout=args.timeout,
    )

    image_path = out_dir / f"edit.{args.output_format}"
    json_path = out_dir / "edit-response.json"
    decode_image_response(response_body, json_path, image_path)
    print(f"edit: HTTP {status} -> {image_path}")
    print(f"edit JSON: {json_path}")
    return image_path


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir).expanduser().resolve() / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.skip_generation and not args.input_image:
        raise RuntimeError("--skip-generation requires --input-image")

    generation_image: Path | None = None
    if not args.skip_generation:
        generation_image = call_generation(args, out_dir)

    if not args.skip_edit:
        input_image = Path(args.input_image).expanduser().resolve() if args.input_image else generation_image
        if input_image is None:
            raise RuntimeError("no input image for edit")
        call_edit(args, out_dir, input_image)

    print(f"output directory: {out_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as err:
        print(f"error: {err}", file=sys.stderr)
        raise SystemExit(1)
