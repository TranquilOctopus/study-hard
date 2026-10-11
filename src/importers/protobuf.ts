// Minimal protobuf wire-format reader: enough to pull scalar, string and
// nested-message fields out of the blobs Anki stores in its collection.

export type ProtoFields = Map<number, (bigint | Uint8Array)[]>;

const utf8 = new TextDecoder();

function readVarint(buf: Uint8Array, pos: { i: number }): bigint {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos.i >= buf.length) throw new Error("Truncated protobuf varint");
    const byte = buf[pos.i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
}

export function decodeMessage(buf: Uint8Array): ProtoFields {
  const fields: ProtoFields = new Map();
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const key = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value: bigint | Uint8Array;
    switch (wire) {
      case 0:
        value = readVarint(buf, pos);
        break;
      case 1:
        value = buf.subarray(pos.i, pos.i + 8);
        pos.i += 8;
        break;
      case 2: {
        const len = Number(readVarint(buf, pos));
        value = buf.subarray(pos.i, pos.i + len);
        pos.i += len;
        break;
      }
      case 5:
        value = buf.subarray(pos.i, pos.i + 4);
        pos.i += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
    if (pos.i > buf.length) throw new Error("Truncated protobuf message");
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

export function getString(fields: ProtoFields, num: number): string {
  const v = fields.get(num)?.at(-1);
  return v instanceof Uint8Array ? utf8.decode(v) : "";
}

export function getVarint(fields: ProtoFields, num: number): number {
  const v = fields.get(num)?.at(-1);
  return typeof v === "bigint" ? Number(v) : 0;
}

export function getMessages(fields: ProtoFields, num: number): ProtoFields[] {
  return (fields.get(num) ?? [])
    .filter((v): v is Uint8Array => v instanceof Uint8Array)
    .map(decodeMessage);
}
