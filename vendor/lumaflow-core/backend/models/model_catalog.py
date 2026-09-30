# encoding:utf-8

"""
Per-provider model catalog: user-managed model entries with metadata
(capability tags, context window, max output tokens).

Config model (config.json top-level key ``provider_model_catalog``)::

    "provider_model_catalog": {
        "zhipu": [                          # built-in vendor id
            {"name": "glm-5.3-flash", "capabilities": ["chat"],
             "context_window": 1000000, "max_output_tokens": 65536}
        ],
        "custom:3f2a9c1b": [ ... ]          # user-defined provider
    }

Semantics
---------
- When a provider has a catalog, it REPLACES the provider's preset model
  list wherever models are offered. Entries tagged "text" are the main-model
  (chat) candidates; the other tags route entries into the matching
  specialized positions (vision, image, embedding, ...). Without a catalog
  the preset behaviour is unchanged.
- Saving an empty list removes the provider's catalog (back to presets).
"""

import json
import os

from config import conf, get_data_root, read_config_template
from common.log import logger

CATALOG_KEY = "provider_model_catalog"

# LumaFlow's model picker is deliberately a catalog-only integration.  The
# local entry is sent through the existing ``custom`` OpenAI-compatible route
# (which can point at Ollama); the Hugging Face entry is display-only until a
# real remote serving endpoint is configured.  Keeping these as catalog data
# means selecting the local demo never needs a model pull, and the placeholder
# never gets mistaken for an installed runtime model.
LUMAFLOW_PROVIDER_ID = "lumaflow"
LUMAFLOW_ROUTE_PROVIDER = "custom"
LUMAFLOW_LOCAL_MODEL_ID = "qwen3:8b"
LUMAFLOW_REMOTE_MODEL_ID = "Qwen/Qwen3.8-Flash-Next"
LUMAFLOW_OLLAMA_API_BASE = "http://localhost:11434/v1"

LUMAFLOW_MODEL_PRESETS = (
    {
        "name": LUMAFLOW_LOCAL_MODEL_ID,
        "label": "Qwen3 8B（本地演示）",
        "capabilities": ["text"],
        "source": "local",
        "backend": "ollama",
        "status": "available",
        "selectable": True,
        "disabled": False,
        "downloadable": False,
        "hint": "local · Ollama/OpenAI-compatible",
    },
    {
        "name": LUMAFLOW_REMOTE_MODEL_ID,
        "label": LUMAFLOW_REMOTE_MODEL_ID,
        "capabilities": ["text"],
        "source": "remote",
        "backend": "hugging-face",
        "status": "not-installed",
        "selectable": False,
        "disabled": True,
        "downloadable": False,
        "hint": "remote · not installed · disabled",
    },
)

# Capability tags route a model into the matching tool position. "text" marks
# a conversational model: only text-tagged entries appear in the main-model
# (chat) dropdown and the conversation switcher. A model may hold several
# tags (e.g. text + vision for a VL model).
VALID_CAPABILITIES = ("text", "vision", "video", "image", "embedding", "asr", "tts")
DEFAULT_CAPABILITIES = ["text"]

# Optional display/runtime metadata used by catalog-backed selectors.  These
# fields are intentionally optional so hand-authored legacy catalog entries
# keep the original normalized shape.
VALID_SOURCES = ("local", "remote")
VALID_BACKENDS = ("ollama", "openai-compatible", "hugging-face")
VALID_STATUSES = ("available", "not-installed", "disabled", "remote")


def _config_path() -> str:
    return os.path.join(get_data_root(), "config.json")


def _read_file_config() -> dict:
    """Baseline dict for a partial write to config.json (same contract as
    web_channel's helper: seed from the template on a fresh install)."""
    path = _config_path()
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return read_config_template()


def normalize_entry(raw) -> dict:
    """Validate one catalog entry, filling defaults. Raises ValueError."""
    if not isinstance(raw, dict):
        raise ValueError("model entry must be an object")
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ValueError("model name is required")

    caps = raw.get("capabilities")
    if caps in (None, ""):
        caps = list(DEFAULT_CAPABILITIES)
    if isinstance(caps, str):
        caps = [caps]
    if not isinstance(caps, list):
        raise ValueError(f"capabilities for {name} must be a list")
    # Silently drop unrecognized tags (e.g. hand-edited config) instead of
    # rejecting the whole entry — the UI only ever offers valid ones.
    caps = [str(c).strip().lower() for c in caps if str(c).strip() in VALID_CAPABILITIES]
    # A model with no tags would be unreachable everywhere (not text, not any
    # capability), so an empty set falls back to the default: text.
    if not caps:
        caps = list(DEFAULT_CAPABILITIES)

    entry = {"name": name, "capabilities": caps}
    for key, allowed in (
        ("source", VALID_SOURCES),
        ("backend", VALID_BACKENDS),
        ("status", VALID_STATUSES),
    ):
        value = raw.get(key)
        if value in (None, ""):
            continue
        value = str(value).strip().lower()
        if value not in allowed:
            raise ValueError(f"{key} for {name} must be one of {allowed}")
        entry[key] = value

    label = raw.get("label")
    if label not in (None, ""):
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"label for {name} must be a non-empty string")
        entry["label"] = label.strip()

    hint = raw.get("hint")
    if hint not in (None, ""):
        if not isinstance(hint, str):
            raise ValueError(f"hint for {name} must be a string")
        entry["hint"] = hint.strip()

    for key in ("selectable", "disabled", "downloadable"):
        value = raw.get(key)
        if value is None:
            continue
        if not isinstance(value, bool):
            raise ValueError(f"{key} for {name} must be a boolean")
        entry[key] = value

    for key in ("context_window", "max_output_tokens"):
        value = raw.get(key)
        if value in (None, ""):
            continue
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{key} for {name} must be a positive integer")
        if value <= 0:
            raise ValueError(f"{key} for {name} must be a positive integer")
        entry[key] = value
    return entry


def get_lumaflow_model_presets() -> list:
    """Return a fresh, normalized copy of the LumaFlow picker presets.

    This function is pure catalog data.  It does not inspect Ollama, call a
    remote endpoint, download weights, or mutate configuration.  Callers may
    safely attach the returned entries to a selector response.
    """
    return [normalize_entry(entry) for entry in LUMAFLOW_MODEL_PRESETS]


def get_catalog_map() -> dict:
    """Live catalog map (provider id -> entries), from the in-memory config.

    Writers keep conf() and config.json in sync, so reads never hit disk —
    the budget and request paths call this every LLM turn. Entries are
    re-normalized on read so stale data (e.g. a hand-edited config or a
    catalog saved by an older build) behaves like the current semantics."""
    catalog = conf().get(CATALOG_KEY)
    if not isinstance(catalog, dict):
        return {}
    healed = {}
    for pid, entries in catalog.items():
        if not isinstance(entries, list):
            continue
        clean = []
        for e in entries:
            try:
                clean.append(normalize_entry(e))
            except (ValueError, TypeError, AttributeError):
                continue  # unparseable entry: skip rather than break reads
        healed[pid] = clean
    return healed


def get_catalog(provider_id) -> list:
    """Return the catalog entries for one provider (empty when absent)."""
    if not provider_id:
        return []
    entries = get_catalog_map().get(provider_id)
    return entries if isinstance(entries, list) else []


def save_catalog(provider_id, models) -> list:
    """Replace one provider's catalog wholesale; an empty list removes it."""
    if not provider_id:
        raise ValueError("provider id is required")
    if not isinstance(models, list):
        raise ValueError("models must be a list")
    entries = [normalize_entry(m) for m in models]
    names = [e["name"] for e in entries]
    if len(names) != len(set(names)):
        raise ValueError("duplicate model name in catalog")

    data = _read_file_config()
    catalog = data.get(CATALOG_KEY)
    if not isinstance(catalog, dict):
        catalog = {}
    if entries:
        catalog[provider_id] = entries
    else:
        catalog.pop(provider_id, None)
    if catalog:
        data[CATALOG_KEY] = catalog
    else:
        data.pop(CATALOG_KEY, None)
    with open(_config_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

    # Keep the in-memory config in sync (same contract as the web config
    # handlers) so runtime readers see the change without a restart.
    local = conf()
    catalog = local.get(CATALOG_KEY)
    if not isinstance(catalog, dict):
        catalog = {}
    if entries:
        catalog[provider_id] = entries
    else:
        catalog.pop(provider_id, None)
    if catalog:
        local[CATALOG_KEY] = catalog
    else:
        local.pop(CATALOG_KEY, None)

    logger.info(f"[ModelCatalog] provider {provider_id} saved: {len(entries)} models")
    return entries


def remove_catalog(provider_id) -> None:
    """Drop one provider's catalog if present (used on provider delete)."""
    try:
        save_catalog(provider_id, [])
    except (OSError, ValueError) as e:
        logger.warning(f"[ModelCatalog] failed to remove catalog for {provider_id}: {e}")


def resolve_model_meta(provider_id, model_name) -> dict:
    """Catalog metadata for one model, or {} when not catalogued."""
    name = str(model_name or "").strip()
    if not provider_id or not name:
        return {}
    for entry in get_catalog(provider_id):
        if entry.get("name") == name:
            return entry
    return {}
