"""Process-local low-memory loaders for Windows Qwen image build and inference."""
from collections.abc import MutableMapping
from pathlib import Path
import json
import struct
import sys


class TensorFile(MutableMapping):
    """Read one tensor on demand instead of copying a whole safetensors shard."""
    def __init__(self, filename):
        self.path = Path(filename)
        self.files = {}
        header, _ = self._open(self.path)
        # Quantization statistics are consumed with their packed weight. Do
        # not later treat them as model parameters in the next shard's loop.
        self.names = dict.fromkeys(key for key in header if key != "__metadata__" and ".weight." not in key)
        self.overrides = {}
        indices = list(self.path.parent.glob("*.safetensors.index.json"))
        self.locations = json.loads(indices[0].read_text(encoding="utf-8"))["weight_map"] if indices else dict.fromkeys((key for key in header if key != "__metadata__"), self.path.name)

    def _open(self, path):
        if path not in self.files:
            handle = path.open("rb")
            size = struct.unpack("<Q", handle.read(8))[0]
            header = json.loads(handle.read(size))
            self.files[path] = (header, size + 8, handle)
        header, offset, _ = self.files[path]
        return header, offset

    def read_tensor(self, key):
        import torch
        path = self.path.parent / self.locations[key]
        header, offset = self._open(path)
        info = header[key]
        start, end = info["data_offsets"]
        dtypes = {"BF16": torch.bfloat16, "F16": torch.float16, "F32": torch.float32,
                  "F64": torch.float64, "I64": torch.int64, "I32": torch.int32,
                  "I16": torch.int16, "I8": torch.int8, "U8": torch.uint8, "BOOL": torch.bool}
        if end == start:
            return torch.empty(info["shape"], dtype=dtypes[info["dtype"]])
        data = bytearray(end - start)
        handle = self.files[path][2]
        handle.seek(offset + start)
        if handle.readinto(data) != len(data):
            raise OSError(f"Incomplete local tensor: {key}")
        return torch.frombuffer(data, dtype=dtypes[info["dtype"]]).reshape(info["shape"])

    def __getitem__(self, key):
        if key in self.overrides:
            return self.overrides[key]
        if key not in self.names:
            raise KeyError(key)
        return self.read_tensor(key)

    def __setitem__(self, key, value):
        self.names[key] = None
        self.overrides[key] = value

    def __delitem__(self, key):
        del self.names[key]
        self.overrides.pop(key, None)

    def __iter__(self):
        return iter(self.names)

    def __len__(self):
        return len(self.names)

    def __del__(self):
        for _, _, handle in self.files.values():
            handle.close()


def configure_windows_loading():
    if sys.platform != "win32":
        return
    import transformers.modeling_utils as hf_loading
    import diffusers.models.modeling_utils as diff_loading
    import diffusers.models.model_loading_utils as diff_utils
    from diffusers.quantizers.bitsandbytes.bnb_quantizer import BnB4BitDiffusersQuantizer
    # CUDA reservations consume Windows commit even before weights are loaded.
    # Override only this worker's functions; do not edit installed packages.
    hf_loading.caching_allocator_warmup = lambda *args, **kwargs: None
    diff_loading._caching_allocator_warmup = lambda *args, **kwargs: None
    if getattr(diff_utils.load_state_dict, "lumaflow_streaming", False):
        return
    original_load = diff_utils.load_state_dict

    def read_checkpoint(checkpoint_file, disable_mmap=False, map_location="cpu"):
        if isinstance(checkpoint_file, MutableMapping):
            return checkpoint_file
        if not isinstance(checkpoint_file, (str, Path)) or Path(checkpoint_file).suffix != ".safetensors" or str(map_location) != "cpu":
            return original_load(checkpoint_file, disable_mmap=disable_mmap, map_location=map_location)
        return TensorFile(checkpoint_file)

    read_checkpoint.lumaflow_streaming = True
    diff_utils.load_state_dict = read_checkpoint
    diff_loading.load_state_dict = read_checkpoint
    original_create = BnB4BitDiffusersQuantizer.create_quantized_param

    def create_param(self, model, param_value, param_name, target_device, state_dict, *args, **kwargs):
        if self.pre_quantized and isinstance(state_dict, TensorFile):
            # The upstream implementation scans every value for each weight.
            # Fetch only this weight's quantization statistics from the file.
            # A packed weight and its statistics may straddle saved shards.
            state_dict = {key: state_dict.read_tensor(key) for key in state_dict.locations if key.startswith(param_name + ".")}
        return original_create(self, model, param_value, param_name, target_device, state_dict, *args, **kwargs)

    BnB4BitDiffusersQuantizer.create_quantized_param = create_param
