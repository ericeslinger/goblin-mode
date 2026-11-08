// A small zip built in a spec (#176), as Feedly's export is one.
/** The bytes of a stream through a CompressionStream, for the deflated entries. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...value);
  }
  return new Uint8Array(parts);
}

/**
 * A small zip, as Feedly's export is one: each file stored, or deflated
 * when asked. The reader goes by the central directory and never checks
 * the CRC, so it is left 0 here.
 */
export async function zipOf(
  files: Record<string, string>,
  deflated = false,
  declared: Record<string, number> = {},
): Promise<Blob> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(body);
    const data = deflated ? await deflate(raw) : raw;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, deflated ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, deflated ? 8 : 0, true);
    dv.setUint32(20, data.length, true);
    dv.setUint32(24, declared[name] ?? raw.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    locals.push(local);
    central.push(dir);
    offset += local.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new Blob([...locals, ...central, end] as BlobPart[]);
}
