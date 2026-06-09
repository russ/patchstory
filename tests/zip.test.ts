import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildZip } from "../packages/cli/src/zip.ts";

test("produces a valid ZIP with recoverable entries", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello world ".repeat(50)) },
    { name: "dir/b.json", data: Buffer.from(JSON.stringify({ x: 1 })) },
  ];
  const zip = buildZip(entries);

  // Local file header + End of central directory signatures.
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocd + 10), entries.length); // total entries

  // Recover the first entry's bytes from its local header.
  const method = zip.readUInt16LE(8);
  const compSize = zip.readUInt32LE(18);
  const nameLen = zip.readUInt16LE(26);
  const extraLen = zip.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  const body = zip.subarray(dataStart, dataStart + compSize);
  const recovered = method === 8 ? inflateRawSync(body) : body;
  assert.equal(recovered.toString(), entries[0].data.toString());
});
