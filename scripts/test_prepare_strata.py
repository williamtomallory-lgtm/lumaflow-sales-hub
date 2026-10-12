import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare-strata-inplace.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallerTests(unittest.TestCase):
    def test_unknown_source_is_refused(self):
        with self.assertRaises(ValueError): module.patch_source('print("unsupported")')

    def test_patch_keeps_non_coder_space_checks_and_copy(self):
        fixture = '''if True:
    need = (MODELS[model]["arena_gb"] + 1 if low_ram and not q2_avx and not pack_bin else 0)
    ok(f"engine: {eng / EXE}")
    if low_ram and not (pack / "experts.bin").exists():
        copy_experts()
'''
        result = module.patch_source(fixture)
        self.assertIn('family != "coder"', result)
        self.assertIn('engine_ver < (0, 1, 43)', result)
        self.assertIn('copy_experts()', result)
        with self.assertRaises(ValueError): module.patch_source(result)


if __name__ == '__main__': unittest.main()
