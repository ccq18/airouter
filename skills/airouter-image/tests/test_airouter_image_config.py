import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "airouter_image.py"
API_KEY_ENV_VAR = "AIROUTER_IMAGE_API_KEY"


def load_script_module():
    spec = importlib.util.spec_from_file_location("airouter_image", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AirouterImageConfigTest(unittest.TestCase):
    def setUp(self):
        self.module = load_script_module()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.module.CONFIG_PATH = Path(self.temp_dir.name) / "config.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    def write_config(self, api_key="", api_base="https://airouter.example.test/v1"):
        config = dict(self.module.DEFAULT_CONFIG)
        config["api_key"] = api_key
        config["api_base"] = api_base
        self.module.CONFIG_PATH.write_text(json.dumps(config), encoding="utf-8")

    def test_default_config_does_not_embed_an_api_key(self):
        self.assertEqual("", self.module.DEFAULT_CONFIG["api_key"])

    def test_default_config_requires_an_explicit_api_endpoint(self):
        self.assertEqual("", self.module.DEFAULT_CONFIG["api_base"])

    def test_load_config_accepts_api_key_from_environment(self):
        self.write_config()

        with mock.patch.dict(os.environ, {API_KEY_ENV_VAR: "environment-key"}):
            config = self.module.load_config()

        self.assertEqual("environment-key", config["api_key"])

    def test_environment_api_key_overrides_local_config(self):
        self.write_config(api_key="file-key")

        with mock.patch.dict(os.environ, {API_KEY_ENV_VAR: "environment-key"}):
            config = self.module.load_config()

        self.assertEqual("environment-key", config["api_key"])

    def test_load_config_requires_an_explicit_api_key(self):
        self.write_config()

        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SystemExit, API_KEY_ENV_VAR):
                self.module.load_config()

    def test_load_config_allows_public_plaintext_http_endpoint(self):
        self.write_config(api_base="http://203.0.113.10:3009/v1")

        with mock.patch.dict(os.environ, {API_KEY_ENV_VAR: "environment-key"}):
            config = self.module.load_config()

        self.assertEqual("http://203.0.113.10:3009/v1", config["api_base"])

    def test_load_config_allows_plaintext_http_loopback_endpoint(self):
        self.write_config(api_base="http://127.0.0.1:3009/v1")

        with mock.patch.dict(os.environ, {API_KEY_ENV_VAR: "environment-key"}):
            config = self.module.load_config()

        self.assertEqual("http://127.0.0.1:3009/v1", config["api_base"])

    def test_write_config_restricts_directory_and_file_permissions(self):
        self.module.CONFIG_PATH = (
            Path(self.temp_dir.name) / "airouter-image" / "config.json"
        )

        self.module.write_config()

        directory_mode = stat.S_IMODE(self.module.CONFIG_PATH.parent.stat().st_mode)
        file_mode = stat.S_IMODE(self.module.CONFIG_PATH.stat().st_mode)
        self.assertEqual(0o700, directory_mode)
        self.assertEqual(0o600, file_mode)

    def test_force_write_restricts_existing_config_permissions(self):
        self.module.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        self.module.CONFIG_PATH.write_text("{}", encoding="utf-8")
        self.module.CONFIG_PATH.chmod(0o644)

        self.module.write_config(force=True)

        file_mode = stat.S_IMODE(self.module.CONFIG_PATH.stat().st_mode)
        self.assertEqual(0o600, file_mode)


if __name__ == "__main__":
    unittest.main()
