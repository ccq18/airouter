#!/usr/bin/env python3
"""Automatically retouch an image through Airouter.

The default flow sends the input image to /v1/responses first so the model can
write a focused edit prompt, then sends the original image plus that prompt to
/v1/images/edits.

Examples:
  python scripts/auto_image_edit.py --input-image /path/to/photo.png
  python scripts/auto_image_edit.py --input-image /path/to/photo.png --ak sk-airouter-xxxx
  python scripts/auto_image_edit.py --input-image /path/to/photo.png --prompt "Brighten it naturally"
  python scripts/auto_image_edit.py --input-image /path/to/photo.png --save-debug
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
DEFAULT_RESPONSES_MODEL = "gpt-5.5"
DEFAULT_IMAGE_MODEL = "gpt-image-1.5"
DEFAULT_OUTPUT_FORMAT = "png"
DEFAULT_RETOUCH_GOAL = (
    "Create a concise image-editing prompt that improves this image naturally. "
    "Prefer tasteful retouching: better lighting, cleaner color, sharper details, "
    "reduced noise, and subtle composition polish. Preserve the subject identity, "
    "pose, clothing, background intent, and overall realism. Do not sexualize the "
    "image, do not add text, and do not add a watermark. Return only the final "
    "edit prompt, no markdown."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Retouch one local image through Airouter /v1/responses and /v1/images/edits.",
    )
    parser.add_argument("--input-image", required=True, help="Local image to retouch.")
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
    parser.add_argument(
        "--prompt",
        default="",
        help="Use this edit prompt directly and skip /v1/responses prompt generation.",
    )
    parser.add_argument(
        "--retouch-goal",
        default=DEFAULT_RETOUCH_GOAL,
        help="Instruction sent to /v1/responses when --prompt is not provided.",
    )
    parser.add_argument("--responses-model", default=DEFAULT_RESPONSES_MODEL)
    parser.add_argument("--image-model", default=DEFAULT_IMAGE_MODEL)
    parser.add_argument("--output-format", default=DEFAULT_OUTPUT_FORMAT, choices=("png", "jpeg", "webp"))
    parser.add_argument(
        "--out-dir",
        default=".",
        help="Directory for the edited image, and debug files when --save-debug is set. Defaults to the current folder.",
    )
    parser.add_argument(
        "--save-debug",
        action="store_true",
        help="Save generated prompt and raw JSON/SSE responses next to the edited image.",
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
    headers: dict[str, str],
    body: bytes,
    timeout: float,
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as err:
        error_body = err.read()
        raise RuntimeError(
            f"POST {url} failed with HTTP {err.code}: {error_body.decode('utf-8', 'replace')[:2000]}"
        ) from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"POST {url} failed: {err}") from err


def image_data_url(image_path: Path) -> str:
    content_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def extract_response_text(payload: object) -> str:
    if isinstance(payload, dict):
        output_text = payload.get("output_text")
        if isinstance(output_text, str) and output_text.strip():
            return output_text.strip()

        pieces: list[str] = []
        for item in payload.get("output") or []:
            if not isinstance(item, dict):
                continue
            for content in item.get("content") or []:
                if isinstance(content, dict):
                    text = content.get("text")
                    if isinstance(text, str) and text.strip():
                        pieces.append(text.strip())
        if pieces:
            return "\n".join(pieces).strip()

    raise RuntimeError("responses JSON does not contain output_text")


def parse_sse_payloads(body_text: str) -> list[object]:
    payloads: list[object] = []
    for block in body_text.replace("\r\n", "\n").split("\n\n"):
        data_lines = []
        for line in block.split("\n"):
            if line.startswith("data:"):
                data_lines.append(line[len("data:") :].lstrip())

        data_text = "\n".join(data_lines)
        if not data_text or data_text == "[DONE]":
            continue

        try:
            payloads.append(json.loads(data_text))
        except json.JSONDecodeError:
            continue

    return payloads


def extract_sse_response_text(body_text: str) -> str:
    deltas: list[str] = []
    completed_payloads: list[object] = []
    for payload in parse_sse_payloads(body_text):
        if isinstance(payload, dict) and payload.get("type") == "response.output_text.delta":
            delta = payload.get("delta")
            if isinstance(delta, str):
                deltas.append(delta)

        if isinstance(payload, dict) and payload.get("type") == "response.completed":
            completed_payloads.append(payload.get("response"))

    text = "".join(deltas).strip()
    if text:
        return text

    for payload in reversed(completed_payloads):
        try:
            return extract_response_text(payload)
        except RuntimeError:
            continue

    raise RuntimeError("responses event stream does not contain output text")


def extract_response_body_text(response_body: bytes, response_path: Path | None) -> str:
    body_text = response_body.decode("utf-8", "replace")
    try:
        response_payload = json.loads(body_text)
    except json.JSONDecodeError:
        if response_path is not None:
            response_path.write_text(body_text, encoding="utf-8")
        return extract_sse_response_text(body_text)

    if response_path is not None:
        response_path.write_text(json.dumps(response_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return extract_response_text(response_payload)


def generate_edit_prompt(args: argparse.Namespace, image_path: Path, response_path: Path | None) -> str:
    payload = {
        "model": args.responses_model,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": args.retouch_goal,
                    },
                    {
                        "type": "input_image",
                        "image_url": image_data_url(image_path),
                    },
                ],
            }
        ],
        "store": False,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        **auth_headers(args.api_key),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    status, _, response_body = request_bytes(
        url_join(args.base_url, "/v1/responses"),
        headers=headers,
        body=body,
        timeout=args.timeout,
    )
    prompt = extract_response_body_text(response_body, response_path)
    if response_path is not None:
        print(f"responses prompt: HTTP {status} -> {response_path}")
    else:
        print(f"responses prompt: HTTP {status}")
    return prompt


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


def decode_image_response(response_body: bytes, json_path: Path | None, image_path: Path) -> None:
    try:
        payload = json.loads(response_body.decode("utf-8"))
    except json.JSONDecodeError as err:
        if json_path is not None:
            json_path.write_bytes(response_body)
            raise RuntimeError(f"image edit response is not JSON; saved raw body to {json_path}") from err
        raise RuntimeError("image edit response is not JSON") from err

    if json_path is not None:
        json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    b64_json = ((payload.get("data") or [{}])[0] or {}).get("b64_json")
    if not b64_json:
        if json_path is not None:
            raise RuntimeError(f"image edit response does not contain data[0].b64_json; saved to {json_path}")
        raise RuntimeError("image edit response does not contain data[0].b64_json")

    image_path.write_bytes(base64.b64decode(b64_json))


def call_image_edit(
    args: argparse.Namespace,
    image_path: Path,
    edit_prompt: str,
    output_path: Path,
    response_path: Path | None,
) -> Path:
    fields = {
        "model": args.image_model,
        "prompt": edit_prompt,
        "output_format": args.output_format,
    }
    boundary, body = multipart_body(fields, {"image": image_path})
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

    decode_image_response(response_body, response_path, output_path)
    print(f"edit: HTTP {status} -> {output_path}")
    if response_path is not None:
        print(f"edit JSON: {response_path}")
    return output_path


def main() -> int:
    args = parse_args()
    image_path = Path(args.input_image).expanduser().resolve()
    if not image_path.is_file():
        raise RuntimeError(f"input image does not exist: {image_path}")

    run_id = f"auto-image-edit-{time.strftime('%Y%m%d-%H%M%S')}"
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    prompt_path = out_dir / f"{run_id}-edit-prompt.txt" if args.save_debug else None
    prompt_response_path = out_dir / f"{run_id}-responses-prompt-response.json" if args.save_debug else None
    edit_response_path = out_dir / f"{run_id}-image-edit-response.json" if args.save_debug else None
    output_path = out_dir / f"{run_id}-edited.{args.output_format}"

    edit_prompt = args.prompt.strip()
    if not edit_prompt:
        edit_prompt = generate_edit_prompt(args, image_path, prompt_response_path)

    if prompt_path is not None:
        prompt_path.write_text(edit_prompt + "\n", encoding="utf-8")
        print(f"edit prompt: {prompt_path}")
    call_image_edit(args, image_path, edit_prompt, output_path, edit_response_path)
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
