import os
from unittest.mock import patch

from channel.web import web_channel


def test_integrated_console_redirect_accepts_only_loopback_urls():
    with patch.dict(os.environ, {"COW_LUMAFLOW_UI_URL": "http://127.0.0.1:3000/?ui=agents-v2"}, clear=False):
        assert web_channel._lumaflow_primary_ui_url() == "http://127.0.0.1:3000/?ui=agents-v2"
    for value in ("https://example.com", "http://user:pass@127.0.0.1:3000", "http://127.0.0.1:99999", "http://127.0.0.1:3000/#secret", "http://127.0.0.1:3000/\r\nX-Test: bad"):
        with patch.dict(os.environ, {"COW_LUMAFLOW_UI_URL": value}, clear=False):
            assert web_channel._lumaflow_primary_ui_url() == ""


def test_standalone_console_is_unchanged_without_opt_in():
    with patch.dict(os.environ, {}, clear=True):
        assert web_channel._lumaflow_primary_ui_url() == ""
