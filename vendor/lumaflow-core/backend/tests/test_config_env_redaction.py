"""Secrets supplied through environment overrides must never reach logs."""

from config import _safe_env_log_value


def test_sensitive_environment_values_are_fully_redacted():
    for name in (
        "gemini_api_key",
        "custom_api_key",
        "client_secret",
        "external_api_token",
        "web_password",
        "provider_credential",
    ):
        assert _safe_env_log_value(name, "do-not-log-me") == "<redacted>"


def test_non_sensitive_environment_values_remain_diagnostic():
    assert _safe_env_log_value("model", "qwen3:8b") == "qwen3:8b"
    assert _safe_env_log_value("channel_type", "web") == "web"
