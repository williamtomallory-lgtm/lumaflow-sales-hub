import io
import struct
from types import SimpleNamespace
import unittest
from strata_ternary_pack import make_header


class SidecarHeaderTests(unittest.TestCase):
    def test_offsets_and_shapes_are_gguf_v3(self):
        tensors = [SimpleNamespace(name='blk.23.ffn_gate_exps.weight', shape=[128, 3, 256], elements=128*3*256),
                   SimpleNamespace(name='blk.23.ffn_down_exps.weight', shape=[128, 5, 256], elements=128*5*256)]
        raw, offsets, size = make_header(tensors)
        reader = io.BytesIO(raw)
        self.assertEqual(struct.unpack('<IIQQ', reader.read(24)), (0x46554747, 3, 2, 0))
        expected_offset = 0
        for tensor in tensors:
            n, = struct.unpack('<Q', reader.read(8))
            self.assertEqual(reader.read(n).decode(), tensor.name)
            dims, = struct.unpack('<I', reader.read(4))
            self.assertEqual(list(struct.unpack('<'+'Q'*dims, reader.read(8*dims))), tensor.shape)
            self.assertEqual(struct.unpack('<IQ', reader.read(12)), (42, expected_offset))
            self.assertEqual(offsets[tensor.name], expected_offset)
            expected_offset += tensor.elements // 64 * 18
        self.assertEqual(size, expected_offset)
        self.assertEqual(len(raw) % 32, 0)


if __name__ == '__main__': unittest.main()
