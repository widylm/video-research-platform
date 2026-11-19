export const coverBucket = "video-covers";
export const coverType = "image/jpeg";
export const coverMaxBytes = 512 * 1024;
export const coverMaxSide = 1280;
export const coverUploadMaxBytes = 5 * 1024 * 1024;

export function manualCoverUrl(id: string, revision: string) {
  return `/api/videos/${id}/cover?v=${encodeURIComponent(revision)}`;
}

/** Check the JPEG envelope and declared dimensions before passing bytes to an image decoder. */
export function isCoverJpeg(bytes: Uint8Array): boolean {
  const end = bytes.length - 2;
  if (end < 4 || bytes.length > coverMaxBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[end] !== 0xff || bytes[end + 1] !== 0xd9) return false;

  let dimensions = false;
  for (let offset = 2; offset < end;) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (offset + 2 > end || marker === 0 || marker === 0xd8 || marker === 0xd9) return false;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > end) return false;

    // Only eight-bit baseline and progressive JPEG are supported.
    if (marker === 0xc0 || marker === 0xc2) {
      if (dimensions || length < 8) return false;
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      const components = bytes[offset + 7];
      if (bytes[offset + 2] !== 8 || width < 1 || width > coverMaxSide || height < 1 || height > coverMaxSide
        || (components !== 1 && components !== 3) || length !== 8 + 3 * components) return false;
      dimensions = true;
    }
    if (marker === 0xda) {
      const components = bytes[offset + 2];
      return dimensions && components >= 1 && components <= 3 && length === 6 + 2 * components && offset + length < end;
    }
    offset += length;
  }
  return false;
}
