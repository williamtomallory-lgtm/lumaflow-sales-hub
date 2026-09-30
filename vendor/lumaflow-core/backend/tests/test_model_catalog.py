# encoding:utf-8

import unittest

from models import model_catalog


class TestLumaFlowCatalog(unittest.TestCase):
    def test_presets_are_pure_metadata_and_return_fresh_entries(self):
        first = model_catalog.get_lumaflow_model_presets()
        self.assertEqual(
            [entry["name"] for entry in first],
            ["qwen3:8b", "Qwen/Qwen3.8-Flash-Next"],
        )

        first[0]["label"] = "mutated"
        second = model_catalog.get_lumaflow_model_presets()
        self.assertEqual(second[0]["label"], "Qwen3 8B（本地演示）")
        self.assertFalse(second[1]["selectable"])
        self.assertTrue(second[1]["disabled"])
        self.assertFalse(second[1]["downloadable"])

    def test_legacy_entries_keep_their_original_normalized_shape(self):
        entry = model_catalog.normalize_entry({
            "name": "legacy-model",
            "capabilities": ["text"],
            "context_window": "4096",
        })
        self.assertEqual(entry, {
            "name": "legacy-model",
            "capabilities": ["text"],
            "context_window": 4096,
        })

    def test_metadata_validation_rejects_bad_selector_state(self):
        with self.assertRaises(ValueError):
            model_catalog.normalize_entry({
                "name": "bad-model",
                "status": "download-now",
            })
        with self.assertRaises(ValueError):
            model_catalog.normalize_entry({
                "name": "bad-model",
                "selectable": "false",
            })


if __name__ == "__main__":
    unittest.main()
