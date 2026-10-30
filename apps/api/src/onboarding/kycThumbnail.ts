import sharp from "sharp";
import type { DetectedFileType } from "./fileSignature.js";

/**
 * Longest side, in pixels.
 */
const THUMBNAIL_MAX_DIMENSION_PX = 320;

// sharp keeps decoded images in an in-process cache by default; on a 512 MB
// container that cache was the top cause of OOM restarts (RUNBOOK). Turn it off
// here instead of relying on someone remembering SHARP_CACHE=0.
sharp.cache(false);

export interface GeneratedThumbnail {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generates a review-UI-sized thumbnail from an already-validated upload
 * buffer. Only `jpeg`/`png` documents get one — a `pdf` (commercial
 * registration, bank letter) has no image to thumbnail, and this returns
 * `null` rather than attempting a PDF-to-image conversion. Always
 * re-encodes to JPEG regardless of the source format, so the admin
 * console's `<img>` tag never needs to branch on thumbnail mime type the
 * way the original-file endpoint does.
 */
export async function generateKycThumbnail(
  buffer: Buffer,
  detectedType: DetectedFileType,
): Promise<GeneratedThumbnail | null> {
  if (detectedType !== "jpeg" && detectedType !== "png") {
    return null;
  }
  // S17 fix: what was wrong — sharp was given no pixel limit. Why — the 8 MiB
  // cap limits the *file* size, but a small, highly compressed PNG can claim
  // e.g. 20000×20000 pixels and sharp decodes all of it. What it broke — one
  // upload could use gigabytes and the 512 MB API gets OOM-killed (the RUNBOOK's
  // "restarts with no stack trace"). 40 MP covers any real phone photo or scan.
  const resized = await sharp(buffer, { limitInputPixels: 40_000_000 })
    .resize(THUMBNAIL_MAX_DIMENSION_PX, THUMBNAIL_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
  return { buffer: resized, mimeType: "image/jpeg" };
}
