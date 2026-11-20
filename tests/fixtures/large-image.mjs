import { crc32, deflateSync } from "node:zlib";

function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), bytes]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

export function largeImage() {
  const width = 640;
  const height = 640;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((1 + width * 3) * height);
  for (let row = 0; row < height; row++) {
    pixels.fill(
      row % 256,
      row * (1 + width * 3) + 1,
      (row + 1) * (1 + width * 3),
    );
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
