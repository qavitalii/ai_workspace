const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const rasterMime = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const;

export function rasterImageFormat(
  bytes: Buffer,
): keyof typeof rasterMime | undefined {
  if (bytes.subarray(0, 8).equals(pngSignature)) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (/^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "gif";
  if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
}
