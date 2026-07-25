import struct

import pytest

from macho_normalizer import MachOFormatError, normalize_macho, parse_macho


def make_fixture(bits=64, endian="little", signature_size=32):
    order = "<" if endian == "little" else ">"
    header_size = 32 if bits == 64 else 28
    segment_command = 0x19 if bits == 64 else 0x1
    segment_size = 72 if bits == 64 else 56
    command_size = segment_size + 16
    payload = b"unbun-macho-normalizer-v1"
    signature_offset = header_size + command_size + len(payload)
    file_size = signature_offset + signature_size
    data = bytearray(file_size)
    struct.pack_into(f"{order}I", data, 0, 0xFEEDFACF if bits == 64 else 0xFEEDFACE)
    struct.pack_into(f"{order}IIIIII", data, 4, 0x01000007 if bits == 64 else 7, 3, 2, 2, command_size, 0)
    if bits == 64:
        struct.pack_into(f"{order}I", data, 28, 0)
    offset = header_size
    struct.pack_into(f"{order}II", data, offset, segment_command, segment_size)
    data[offset + 8 : offset + 18] = b"__LINKEDIT"
    if bits == 64:
        struct.pack_into(f"{order}QQQQ", data, offset + 24, 0x100000000, len(payload) + signature_size, header_size + command_size, len(payload) + signature_size)
    else:
        struct.pack_into(f"{order}IIII", data, offset + 24, 0x1000, file_size, header_size + command_size, len(payload) + signature_size)
    offset += segment_size
    struct.pack_into(f"{order}IIII", data, offset, 0x1D, 16, signature_offset, signature_size)
    data[header_size + command_size : signature_offset] = payload
    data[signature_offset:] = bytes([0xA1 if signature_size == 32 else 0xB2]) * signature_size
    return bytes(data)


@pytest.mark.parametrize(("bits", "endian"), [(64, "little"), (64, "big"), (32, "little"), (32, "big")])
def test_parses_thin_headers_and_unique_signature(bits, endian):
    parsed = parse_macho(make_fixture(bits, endian))
    assert parsed.bits == bits
    assert parsed.endian == endian
    assert parsed.ncmds == 2
    assert parsed.signature.datasize == 32
    assert parsed.linkedit.segname == "__LINKEDIT"


def test_normalizes_signature_and_affected_size_fields():
    original = make_fixture(signature_size=32)
    resigned = make_fixture(signature_size=80)
    original_parsed = parse_macho(original)
    resigned_parsed = parse_macho(resigned)
    assert resigned_parsed.signature.datasize != original_parsed.signature.datasize
    assert resigned_parsed.linkedit.filesize != original_parsed.linkedit.filesize
    assert resigned_parsed.linkedit.vmsize != original_parsed.linkedit.vmsize
    assert len(resigned) != len(original)
    assert normalize_macho(resigned) == normalize_macho(original)


@pytest.mark.parametrize("kind", ["conflicting-command", "out-of-bounds-blob", "overlapping-command", "truncated-load-command"])
def test_fails_closed(kind):
    data = bytearray(make_fixture())
    if kind == "conflicting-command":
        data[120:120] = data[104:120]
        struct.pack_into("<II", data, 16, 3, 104)
    elif kind == "out-of-bounds-blob":
        struct.pack_into("<I", data, 112, len(data) + 1)
    elif kind == "overlapping-command":
        struct.pack_into("<II", data, 112, 112, len(data) - 112)
    else:
        struct.pack_into("<I", data, 108, 24)
    with pytest.raises(MachOFormatError):
        normalize_macho(bytes(data))


@pytest.mark.parametrize("kind", ["fat-container", "missing-signature", "signature-not-at-eof"])
def test_rejects_unverifiable_boundaries(kind):
    data = bytearray(make_fixture())
    if kind == "fat-container":
        struct.pack_into(">I", data, 0, 0xCAFEBABE)
    elif kind == "missing-signature":
        struct.pack_into("<I", data, 104, 0x2)
    else:
        struct.pack_into("<I", data, 112, struct.unpack_from("<I", data, 112)[0] - 1)
    with pytest.raises(MachOFormatError):
        normalize_macho(bytes(data))


def test_fails_closed_for_big_endian_out_of_bounds_signature():
    data = bytearray(make_fixture(endian="big"))
    struct.pack_into(">I", data, 112, len(data) + 1)
    with pytest.raises(MachOFormatError):
        normalize_macho(bytes(data))