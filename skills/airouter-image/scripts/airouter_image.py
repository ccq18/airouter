#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path


CONFIG_PATH = Path.home() / ".config" / "airouter-image" / "config.json"
API_KEY_ENV_VAR = "AIROUTER_IMAGE_API_KEY"
CONFIG_DIRECTORY_MODE = 0o700
CONFIG_FILE_MODE = 0o600
SUPPORTED_MODELS = {
    "1": "gpt-image-1",
    "1.0": "gpt-image-1",
    "gpt-image-1": "gpt-image-1",
    "gpt-image-1.0": "gpt-image-1",
    "1.5": "gpt-image-1.5",
    "gpt-image-1.5": "gpt-image-1.5",
    "2": "gpt-image-2",
    "2.0": "gpt-image-2",
    "gpt-image-2": "gpt-image-2",
}
SUPPORTED_OUTPUT_FORMATS = {"png", "jpeg", "webp"}
REQUEST_TIMEOUT_SECONDS = 300
DEFAULT_CONFIG = {
    "api_base": "",
    "api_key": "",
    "default_model": "gpt-image-2",
    "output_format": "png",
}


def fail(message):
    raise SystemExit(message)


def ensure_parent(path):
    path.parent.mkdir(parents=True, exist_ok=True)


def write_config(force=False):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True, mode=CONFIG_DIRECTORY_MODE)
    CONFIG_PATH.parent.chmod(CONFIG_DIRECTORY_MODE)
    if CONFIG_PATH.exists() and not force:
        fail(f"config already exists: {CONFIG_PATH}")
    descriptor = os.open(
        CONFIG_PATH,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        CONFIG_FILE_MODE,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
        config_file.write(json.dumps(DEFAULT_CONFIG, indent=2) + "\n")
    CONFIG_PATH.chmod(CONFIG_FILE_MODE)
    print(f"config saved: {CONFIG_PATH}")


def load_config():
    if not CONFIG_PATH.exists():
        fail(f"config not found: {CONFIG_PATH}\nrun: python3 {Path(__file__)} init-config")
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        fail(f"invalid config json: {err}")
    if not isinstance(config, dict):
        fail("config must be a JSON object")
    for key in ("default_model",):
        if not isinstance(config.get(key), str) or not config[key].strip():
            fail(f"config field must be a non-empty string: {key}")
    config["api_base"] = normalize_api_base(config.get("api_base"))
    api_key = os.environ.get(API_KEY_ENV_VAR) or config.get("api_key")
    if not isinstance(api_key, str) or not api_key.strip():
        fail(
            f"API key is required: set {API_KEY_ENV_VAR} or populate api_key in "
            f"{CONFIG_PATH}"
        )
    config["api_key"] = api_key.strip()
    config["default_model"] = normalize_model(config["default_model"])
    output_format = str(config.get("output_format") or "png").strip().lower()
    if output_format not in SUPPORTED_OUTPUT_FORMATS:
        fail("config output_format must be png, jpeg, or webp")
    config["output_format"] = output_format
    return config


def normalize_api_base(value):
    api_base = str(value or "").strip().rstrip("/")
    if not api_base:
        fail("config field must be a non-empty string: api_base")

    parsed = urllib.parse.urlparse(api_base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        fail("config api_base must be an absolute HTTP or HTTPS URL")
    return api_base


def normalize_model(value):
    key = str(value or "").strip().lower()
    if not key:
        fail("model is required")
    model = SUPPORTED_MODELS.get(key)
    if not model:
        supported = ", ".join(["gpt-image-1", "gpt-image-1.5", "gpt-image-2"])
        fail(f"unsupported model: {value}. supported models: {supported}")
    return model


def normalize_output_format(value):
    output_format = str(value or "").strip().lower()
    if not output_format:
        return "png"
    if output_format not in SUPPORTED_OUTPUT_FORMATS:
        fail("output format must be png, jpeg, or webp")
    return output_format


def mask_secret(value):
    if len(value) <= 10:
        return "*" * len(value)
    return f"{value[:6]}...{value[-4:]}"


def default_output_path(kind, output_format):
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    extension = "jpg" if output_format == "jpeg" else output_format
    return Path.cwd() / f"airouter-{kind}-{timestamp}.{extension}"


def save_image_from_response(response_json, output_path):
    if not isinstance(response_json, dict):
        fail("response is not a JSON object")
    data = response_json.get("data")
    if not isinstance(data, list) or not data:
        fail("response does not contain data[0]")
    first = data[0]
    if not isinstance(first, dict) or not isinstance(first.get("b64_json"), str) or not first["b64_json"]:
        fail("response does not contain data[0].b64_json")
    image_bytes = base64.b64decode(first["b64_json"])
    ensure_parent(output_path)
    output_path.write_bytes(image_bytes)
    print(f"saved image: {output_path}")
    print(f"image bytes: {len(image_bytes)}")
    revised_prompt = first.get("revised_prompt")
    if isinstance(revised_prompt, str) and revised_prompt.strip():
        print(f"revised prompt: {revised_prompt.strip()}")


def build_multipart_body(fields, files):
    boundary = f"airouter-{uuid.uuid4().hex}"
    chunks = []

    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
            str(value).encode("utf-8"),
            b"\r\n",
        ])

    for name, file_path in files.items():
        path = Path(file_path)
        if not path.is_file():
            fail(f"input file not found: {path}")
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.extend([
            f"--{boundary}\r\n".encode("utf-8"),
            (
                f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{path.name}"\r\n'
            ).encode("utf-8"),
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
            path.read_bytes(),
            b"\r\n",
        ])

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return boundary, b"".join(chunks)


def send_request(url, headers, body, timeout_seconds):
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return response.getcode(), response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()
    except urllib.error.URLError as err:
        fail(f"request failed: {err}")


def parse_json_response(status_code, raw_body):
    text = raw_body.decode("utf-8", errors="replace")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        fail(f"http {status_code}, non-json response:\n{text[:1000]}")
    if status_code < 200 or status_code >= 300:
        fail(f"http {status_code}, error response:\n{json.dumps(payload, ensure_ascii=False, indent=2)}")
    return payload


def run_generate(args):
    config = load_config()
    model = normalize_model(args.model or config["default_model"])
    output_format = normalize_output_format(args.output_format or config["output_format"])
    output_path = Path(args.output).expanduser() if args.output else default_output_path("generated", output_format)
    payload = {
        "model": model,
        "prompt": args.prompt,
        "output_format": output_format,
    }
    url = f"{config['api_base'].rstrip('/')}/images/generations"
    headers = {
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": "application/json",
    }
    status_code, raw_body = send_request(
        url,
        headers,
        json.dumps(payload).encode("utf-8"),
        REQUEST_TIMEOUT_SECONDS,
    )
    response_json = parse_json_response(status_code, raw_body)
    print(f"http status: {status_code}")
    save_image_from_response(response_json, output_path)


def run_edit(args):
    config = load_config()
    model = normalize_model(args.model or config["default_model"])
    output_format = normalize_output_format(args.output_format or config["output_format"])
    output_path = Path(args.output).expanduser() if args.output else default_output_path("edited", output_format)
    fields = {
        "model": model,
        "prompt": args.prompt,
        "output_format": output_format,
    }
    boundary, body = build_multipart_body(fields, {"image": args.input_image})
    url = f"{config['api_base'].rstrip('/')}/images/edits"
    headers = {
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    status_code, raw_body = send_request(
        url,
        headers,
        body,
        REQUEST_TIMEOUT_SECONDS,
    )
    response_json = parse_json_response(status_code, raw_body)
    print(f"http status: {status_code}")
    save_image_from_response(response_json, output_path)


def run_show_config(_args):
    config = load_config()
    visible = dict(config)
    visible["api_key"] = mask_secret(visible["api_key"])
    print(json.dumps(visible, ensure_ascii=False, indent=2))
    print(f"config path: {CONFIG_PATH}")


def build_parser():
    parser = argparse.ArgumentParser(description="Generate or edit images through an Airouter proxy.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init-config", help="write the default local config file")
    init_parser.add_argument("--force", action="store_true", help="overwrite the config file if it exists")
    init_parser.set_defaults(func=lambda args: write_config(force=args.force))

    show_parser = subparsers.add_parser("show-config", help="show the current local config")
    show_parser.set_defaults(func=run_show_config)

    generate_parser = subparsers.add_parser("generate", help="generate an image")
    generate_parser.add_argument("--prompt", required=True, help="image generation prompt")
    generate_parser.add_argument("--model", help="1.0, 1.5, 2, or the API model name")
    generate_parser.add_argument("--output", help="output image path")
    generate_parser.add_argument("--output-format", help="png, jpeg, or webp")
    generate_parser.set_defaults(func=run_generate)

    edit_parser = subparsers.add_parser("edit", help="edit an image")
    edit_parser.add_argument("--input-image", required=True, help="input image path")
    edit_parser.add_argument("--prompt", required=True, help="image edit prompt")
    edit_parser.add_argument("--model", help="1.0, 1.5, 2, or the API model name")
    edit_parser.add_argument("--output", help="output image path")
    edit_parser.add_argument("--output-format", help="png, jpeg, or webp")
    edit_parser.set_defaults(func=run_edit)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
