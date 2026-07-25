import struct
import sys
from dataclasses import dataclass
from pathlib import Path


LC_SEGMENT = 0x1
LC_SEGMENT_64 = 0x19
LC_CODE_SIGNATURE = 0x1D


class MachOFormatError(ValueError):
    pass


@dataclass(frozen=True)
class CodeSignature:
    command_offset: int
    dataoff: int
    datasize: int


@dataclass(frozen=True)
class LinkeditSegment:
    command_offset: int
    segname: str
    vmsize_offset: int
    filesize_offset: int
    fileoff: int
    filesize: int
    vmsize: int


@dataclass(frozen=True)
class MachOImage:
    bits: int
    endian: str
    header_size: int
    ncmds: int
    sizeofcmds: int
    commands_end: int
    file_length: int
    signature: CodeSignature
    linkedit: LinkeditSegment


def _reject(message: str) -> None:
    raise MachOFormatError(f"invalid thin Mach-O: {message}")


def _format(data: bytes) -> tuple[int, str, str, int]:
    if len(data) < 4:
        _reject("truncated magic")
    magic = data[:4]
    formats = {
        bytes.fromhex("cffaedfe"): (64, "little", "<", 32),
        bytes.fromhex("feedfacf"): (64, "big", ">", 32),
        bytes.fromhex("cefaedfe"): (32, "little", "<", 28),
        bytes.fromhex("feedface"): (32, "big", ">", 28),
    }
    if magic not in formats:
        _reject(f"unsupported magic {magic.hex()}")
    return formats[magic]


def _unpack(data: bytes, order: str, layout: str, offset: int) -> tuple[int, ...]:
    parser = struct.Struct(f"{order}{layout}")
    if offset < 0 or offset + parser.size > len(data):
        _reject(f"truncated {layout} at {offset}")
    return parser.unpack_from(data, offset)


def _segment_name(data: bytes, offset: int) -> str:
    return data[offset : offset + 16].split(b"\0", 1)[0].decode("ascii", errors="strict")


def parse_macho(data: bytes) -> MachOImage:
    bits, endian, order, header_size = _format(data)
    if len(data) < header_size:
        _reject("truncated header")
    ncmds, sizeofcmds = _unpack(data, order, "II", 16)
    commands_end = header_size + sizeofcmds
    if commands_end > len(data):
        _reject("load command region exceeds the file")

    signatures: list[CodeSignature] = []
    linkedits: list[LinkeditSegment] = []
    command_offset = header_size
    expected_segment = LC_SEGMENT_64 if bits == 64 else LC_SEGMENT
    minimum_segment_size = 72 if bits == 64 else 56
    for index in range(ncmds):
        if command_offset + 8 > commands_end:
            _reject(f"truncated load command {index}")
        command, command_size = _unpack(data, order, "II", command_offset)
        if command_size < 8 or command_size % 4:
            _reject(f"invalid cmdsize for load command {index}")
        command_end = command_offset + command_size
        if command_end > commands_end:
            _reject(f"truncated load command {index}")

        if command == LC_CODE_SIGNATURE:
            if command_size != 16:
                _reject("LC_CODE_SIGNATURE must be exactly 16 bytes")
            dataoff, datasize = _unpack(data, order, "II", command_offset + 8)
            signatures.append(CodeSignature(command_offset, dataoff, datasize))

        if command == expected_segment and _segment_name(data, command_offset + 8) == "__LINKEDIT":
            if command_size < minimum_segment_size:
                _reject("truncated __LINKEDIT segment command")
            if bits == 64:
                _vmaddr, vmsize, fileoff, filesize = _unpack(data, order, "QQQQ", command_offset + 24)
                vmsize_offset = command_offset + 32
                filesize_offset = command_offset + 48
            else:
                _vmaddr, vmsize, fileoff, filesize = _unpack(data, order, "IIII", command_offset + 24)
                vmsize_offset = command_offset + 28
                filesize_offset = command_offset + 36
            linkedits.append(LinkeditSegment(command_offset, "__LINKEDIT", vmsize_offset, filesize_offset, fileoff, filesize, vmsize))
        command_offset = command_end

    if command_offset != commands_end:
        _reject("ncmds does not consume sizeofcmds")
    if len(signatures) != 1:
        _reject(f"expected one LC_CODE_SIGNATURE, found {len(signatures)}")
    if len(linkedits) != 1:
        _reject(f"expected one __LINKEDIT segment, found {len(linkedits)}")
    signature = signatures[0]
    linkedit = linkedits[0]
    if signature.datasize == 0:
        _reject("empty code signature blob")
    signature_end = signature.dataoff + signature.datasize
    linkedit_end = linkedit.fileoff + linkedit.filesize
    if signature_end > len(data) or signature_end < signature.dataoff:
        _reject("code signature blob is out of bounds")
    if linkedit_end > len(data) or linkedit_end < linkedit.fileoff:
        _reject("__LINKEDIT range is out of bounds")
    if signature.dataoff < linkedit.fileoff or signature_end > linkedit_end:
        _reject("code signature blob is outside __LINKEDIT")
    if signature_end != len(data) or linkedit_end != len(data):
        _reject("code signature and __LINKEDIT must end at EOF")
    if signature.dataoff < commands_end:
        _reject("code signature overlaps load commands")

    return MachOImage(bits, endian, header_size, ncmds, sizeofcmds, commands_end, len(data), signature, linkedit)


def normalize_macho(data: bytes) -> bytes:
    parsed = parse_macho(data)
    normalized = bytearray(data[: parsed.signature.dataoff])
    order = "<" if parsed.endian == "little" else ">"
    struct.pack_into(f"{order}II", normalized, parsed.signature.command_offset + 8, 0, 0)
    unsigned_linkedit_size = parsed.signature.dataoff - parsed.linkedit.fileoff
    size_layout = "Q" if parsed.bits == 64 else "I"
    struct.pack_into(f"{order}{size_layout}", normalized, parsed.linkedit.filesize_offset, unsigned_linkedit_size)
    struct.pack_into(f"{order}{size_layout}", normalized, parsed.linkedit.vmsize_offset, unsigned_linkedit_size)
    return bytes(normalized)


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("usage: python macho_normalizer.py <path>")
    try:
        normalized = normalize_macho(Path(sys.argv[1]).read_bytes())
    except MachOFormatError as error:
        print(error, file=sys.stderr)
        return 3
    sys.stdout.buffer.write(normalized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())