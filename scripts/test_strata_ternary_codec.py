import ctypes
import os
from pathlib import Path
import unittest
import numpy as np
from strata_ternary_codec import fit_ternary, hadamard, pack_ptq1, unpack_ptq1, ptq1_to_strata_q2


class CodecTests(unittest.TestCase):
    def test_packing_and_strata_transcode(self):
        rng = np.random.default_rng(20261012)
        codes = rng.integers(-1, 2, (1024, 128), dtype=np.int8)
        scales = rng.uniform(0, 2, 1024).astype(np.float16)
        raw = pack_ptq1(codes, scales)
        actual_codes, actual_scales = unpack_ptq1(raw)
        np.testing.assert_array_equal(actual_codes, codes)
        np.testing.assert_array_equal(actual_scales, scales)
        q2 = np.frombuffer(ptq1_to_strata_q2(raw), np.uint8).reshape(-1, 18)
        decoded = np.stack([((q2[:, 2:] >> shift) & 3).astype(np.int8) - 1 for shift in (0, 2, 4, 6)], axis=2).reshape(-1, 64)
        q2_scales = np.ascontiguousarray(q2[:, :2]).view(np.float16).reshape(-1)
        np.testing.assert_array_equal(decoded.reshape(-1, 128), codes)
        np.testing.assert_array_equal(q2_scales, scales.repeat(2))

    def test_prism_binary_oracle(self):
        dll = Path(__file__).resolve().parents[1] / '.local-runtime/bonsai/bin/ggml-base.dll'
        if os.name != 'nt' or not dll.exists():
            self.skipTest('Installed PrismML binary oracle unavailable')
        with os.add_dll_directory(str(dll.parent)):
            lib = ctypes.CDLL(str(dll))
        class Traits(ctypes.Structure):
            _fields_ = [('name', ctypes.c_char_p), ('block', ctypes.c_int64), ('interleave', ctypes.c_int64),
                        ('size', ctypes.c_size_t), ('quantized', ctypes.c_bool), ('to_float', ctypes.c_void_p), ('from_float', ctypes.c_void_p)]
        lib.ggml_get_type_traits.restype = ctypes.POINTER(Traits)
        trait = lib.ggml_get_type_traits(143).contents
        self.assertEqual((trait.name, trait.block, trait.size), (b'ptq1_0', 128, 28))
        decode = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64)(trait.to_float)
        encode = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64)(trait.from_float)
        rng = np.random.default_rng(23)
        codes = rng.integers(-1, 2, (256, 128), dtype=np.int8)
        scales = rng.uniform(.01, 3, 256).astype(np.float16)
        values = np.ascontiguousarray(codes * scales.astype(np.float32)[:, None])
        expected = pack_ptq1(codes, scales)
        output = ctypes.create_string_buffer(len(expected))
        encode(values.ctypes.data, output, values.size)
        self.assertEqual(output.raw, expected)
        decoded = np.empty(values.shape, np.float32)
        decode(output, decoded.ctypes.data, values.size)
        np.testing.assert_array_equal(decoded, values)
        q2_trait = lib.ggml_get_type_traits(42).contents
        self.assertEqual((q2_trait.name, q2_trait.block, q2_trait.size), (b'q2_0', 64, 18))
        q2_decode = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64)(q2_trait.to_float)
        q2_buffer = ctypes.create_string_buffer(ptq1_to_strata_q2(expected))
        q2_decode(q2_buffer, decoded.ctypes.data, values.size)
        np.testing.assert_array_equal(decoded, values)

    def test_optimal_fit_preserves_already_ternary(self):
        values = np.tile(np.array([-1, 0, 1, 0], np.float32), 64).reshape(2, 128)
        codes, scales = unpack_ptq1(fit_ternary(values))
        np.testing.assert_array_equal(codes * scales[:, None], values)

    def test_rotation_requires_paired_activations(self):
        rng = np.random.default_rng(33)
        w, x = rng.normal(size=(12, 640)).astype(np.float32), rng.normal(size=(640,)).astype(np.float32)
        np.testing.assert_allclose(hadamard(w) @ hadamard(x), w @ x, rtol=2e-5, atol=2e-5)
        np.testing.assert_allclose(hadamard(hadamard(w)), w, rtol=2e-5, atol=2e-5)
        with self.assertRaises(ValueError): hadamard(w, 1024)

    def test_invalid_input_fails_closed(self):
        with self.assertRaises(ValueError): unpack_ptq1(b'bad')
        with self.assertRaises(ValueError): pack_ptq1(np.full((1, 128), 2), [1])
        with self.assertRaises(ValueError): fit_ternary([np.nan] * 128)


if __name__ == '__main__': unittest.main()
