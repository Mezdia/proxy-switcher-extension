/* ═══════════════════════════════════════════════════
   Deterministic ZIP writer/reader built on node:zlib.
   Keeps the build free of third-party packaging deps.
   ═══════════════════════════════════════════════════ */

import {deflateRawSync, inflateRawSync} from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

export function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

// MS-DOS timestamps are fixed to 1980-01-01 so a rebuild cannot differ by time.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function encodeName(name) {
    const bytes = Buffer.from(name, 'utf8');
    return {bytes, utf8: !bytes.equals(Buffer.from(name, 'latin1'))};
}

function writeU16(value) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    return b;
}

function writeU32(value) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    return b;
}

export function createZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const entry of entries) {
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const {bytes: nameBuf, utf8} = encodeName(entry.name);
        const flags = utf8 ? 0x0800 : 0;
        const deflated = entry.store ? null : deflateRawSync(data, {level: 9});
        const useDeflate = deflated !== null && deflated.length < data.length;
        const payload = useDeflate ? deflated : data;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(data);

        const local = Buffer.concat([
            writeU32(0x04034b50), writeU16(20), writeU16(flags), writeU16(method),
            writeU16(DOS_TIME), writeU16(DOS_DATE), writeU32(crc),
            writeU32(payload.length), writeU32(data.length),
            writeU16(nameBuf.length), writeU16(0), nameBuf, payload,
        ]);
        locals.push(local);

        centrals.push(Buffer.concat([
            writeU32(0x02014b50), writeU16(20), writeU16(20), writeU16(flags), writeU16(method),
            writeU16(DOS_TIME), writeU16(DOS_DATE), writeU32(crc),
            writeU32(payload.length), writeU32(data.length),
            writeU16(nameBuf.length), writeU16(0), writeU16(0),
            writeU16(0), writeU16(0), writeU32((0o100644 << 16) >>> 0), writeU32(offset), nameBuf,
        ]));

        offset += local.length;
    }

    const central = Buffer.concat(centrals);
    const end = Buffer.concat([
        writeU32(0x06054b50), writeU16(0), writeU16(0),
        writeU16(entries.length), writeU16(entries.length),
        writeU32(central.length), writeU32(offset), writeU16(0),
    ]);

    return Buffer.concat([...locals, central, end]);
}

export function readZip(buffer) {
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd === -1) throw new Error('not a zip: missing end-of-central-directory');

    const count = buffer.readUInt16LE(eocd + 10);
    let ptr = buffer.readUInt32LE(eocd + 16);
    const out = [];

    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error('corrupt central directory header');
        const method = buffer.readUInt16LE(ptr + 10);
        const crc = buffer.readUInt32LE(ptr + 16);
        const compressedSize = buffer.readUInt32LE(ptr + 20);
        const uncompressedSize = buffer.readUInt32LE(ptr + 24);
        const nameLen = buffer.readUInt16LE(ptr + 28);
        const extraLen = buffer.readUInt16LE(ptr + 30);
        const commentLen = buffer.readUInt16LE(ptr + 32);
        const localOffset = buffer.readUInt32LE(ptr + 42);
        const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
        const localNameLen = buffer.readUInt16LE(localOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);
        const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);

        if (data.length !== uncompressedSize) throw new Error(`size mismatch for ${name}`);
        if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);

        out.push({name, data, method, crc});
        ptr += 46 + nameLen + extraLen + commentLen;
    }

    return out;
}
