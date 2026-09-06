// "Find the photos I'm in" — enrolment-based face matching.
//
// ONLY an enrolled guest's own template is stored, with their explicit consent. Faces belonging to
// anyone else are embedded transiently to compare against, then discarded inside the request; what
// survives is a link (photo -> participant), which is personal information but not a biometric
// template.
//
// Be honest about the limit of that: it removes retention and breach exposure for non-enrolled
// guests, but collection happens when a face is ANALYSED, not when it is saved. Hence the feature is
// off by default, gated on the host enabling it and the guest opting in.
//
// Inference runs against a self-hosted Immich ML container over HTTP — image bytes in, vectors out,
// no volume mounts — so it can live on the same box or another one, and MUST stay in-country.
import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';

// Read lazily rather than captured at import: the kill switch is the whole safety story for this
// feature, and a module-level const means the value depends on import ORDER, which is exactly the
// kind of thing that is true in a test and false in production.
const mlUrl = (): string => (process.env.MACHINE_LEARNING_URL || '').trim().replace(/\/$/, '');
export const faceMatchingAvailable = (): boolean => !!mlUrl();

// buffalo_l (InsightFace) via Immich ML. Detection + recognition in one call.
const entriesFor = (minScore: number) => JSON.stringify({
  'facial-recognition': {
    detection: { modelName: 'buffalo_l', options: { minScore } },
    recognition: { modelName: 'buffalo_l' },
  },
});

// Two floors, because the two jobs are not the same job. A gallery photo is candid — faces are
// small, turned away, half behind someone's shoulder — and a loose floor there invents matches.
// A selfie is the opposite: one cooperative face, filling the frame, taken on purpose. Judging it
// at the candid threshold is what rejects a perfectly good selfie with "we couldn't find a face".
const SCENE_MIN_SCORE  = Number(process.env.FACE_MIN_SCORE || 0.7);
const SELFIE_MIN_SCORE = Number(process.env.FACE_SELFIE_MIN_SCORE || 0.5);

// Cosine similarity on unit vectors is a dot product, so normalise once at the door and never again.
export const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.42);

function normalise(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  return n > 0 ? v.map((x) => x / n) : v;
}

export function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export interface DetectedFace { embedding: number[]; score: number }

/**
 * Every face in one image, as unit vectors. Runs on the THUMBNAIL, not the original: at 640px the
 * GPU finishes in ~30ms versus ~240ms on a full-size photo, because JPEG decode dominates the
 * large-image case — and faces are found perfectly well at that size.
 * Returns [] on any failure: face matching is a nicety and must never break an upload.
 */
export async function detectFaces(imagePath: string, minScore = SCENE_MIN_SCORE): Promise<DetectedFace[]> {
  const ML_URL = mlUrl();
  if (!ML_URL) return [];
  try {
    if (!fs.existsSync(imagePath)) return [];
    const form = new FormData();
    form.append('entries', entriesFor(minScore));
    form.append('image', new Blob([new Uint8Array(await orientedJpeg(imagePath))]), path.basename(imagePath));
    const ctl = AbortSignal.timeout(Number(process.env.FACE_TIMEOUT_MS || 20000));
    const res = await fetch(`${ML_URL}/predict`, { method: 'POST', body: form, signal: ctl });
    if (!res.ok) { console.warn(`[faces] ML returned ${res.status}`); return []; }
    const data = await res.json() as { 'facial-recognition'?: Array<{ embedding: string | number[]; score: number }> };
    const rows = data['facial-recognition'] || [];
    return rows.map((r) => ({
      // The service returns the vector as a JSON STRING, not an array.
      embedding: normalise(typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding),
      score: Number(r.score) || 0,
    })).filter((f) => f.embedding.length > 0);
  } catch (e) {
    console.warn('[faces] detect failed:', (e as Error).message);
    return [];
  }
}

/**
 * Straighten an image before the ML server ever sees it.
 *
 * The service decodes exactly the bytes it is handed and does NOT apply EXIF orientation — a
 * pixel-rotated copy and one carrying orientation=6 come back with identical scores, so a phone
 * selfie held in portrait is analysed lying on its side. That costs detection score (enough to
 * fall under the floor and be rejected outright) and, worse, produces an embedding of a sideways
 * face which then fails to match the upright gallery thumbnails. Our own thumbnailer already
 * calls .rotate() for exactly this reason; the selfie path was the one that skipped it.
 *
 * Falls back to the original bytes rather than failing: a selfie that sharp cannot parse is still
 * worth letting the ML server try.
 */
async function orientedJpeg(imagePath: string): Promise<Buffer> {
  try {
    return await sharp(imagePath).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 }).toBuffer();
  } catch {
    return fs.readFileSync(imagePath);
  }
}

/** The single enrolled face from a guest's selfie: the largest, which is the one holding the phone. */
export async function embedSelfie(imagePath: string): Promise<number[] | null> {
  const faces = await detectFaces(imagePath, SELFIE_MIN_SCORE);
  if (!faces.length) {
    // A rejected selfie is the one failure a guest actually feels, and "we couldn't find a face"
    // tells us nothing about WHY. Probe once at a floor low enough to catch a weak detection, and
    // record the shape of the image. Dimensions and format only — never the image, never the face.
    try {
      const meta = await sharp(imagePath).metadata();
      const weak = await detectFaces(imagePath, 0.1);
      const best = weak.length ? Math.max(...weak.map((f) => f.score)) : 0;
      console.warn('[faces] selfie rejected — ' + JSON.stringify({
        format: meta.format, w: meta.width, h: meta.height, exifOrientation: meta.orientation ?? null,
        facesAtFloor: 0, facesAtProbe: weak.length, bestScore: Number(best.toFixed(3)), floor: SELFIE_MIN_SCORE,
      }));
    } catch (e) { console.warn('[faces] selfie rejected and unreadable by sharp:', (e as Error).message); }
    return null;
  }
  let best = faces[0], bestScore = -1;
  for (const f of faces) if (f.score > bestScore) { best = f; bestScore = f.score; }
  return best.embedding;
}

/**
 * Which of these enrolled guests appear in this image. The gallery photo's own face vectors exist
 * only for the duration of this call — nothing about a non-enrolled person is returned or kept.
 */
export async function matchAgainstEnrolled(
  imagePath: string,
  enrolled: Array<{ participantId: string; embedding: number[] }>,
): Promise<Array<{ participantId: string; score: number }>> {
  if (!enrolled.length) return [];
  const faces = await detectFaces(imagePath);
  if (!faces.length) return [];
  const hits: Array<{ participantId: string; score: number }> = [];
  for (const person of enrolled) {
    let best = -1;
    for (const f of faces) {
      const s = similarity(person.embedding, f.embedding);
      if (s > best) best = s;
    }
    if (best >= MATCH_THRESHOLD) hits.push({ participantId: person.participantId, score: best });
  }
  return hits;   // `faces` goes out of scope here, and with it every non-enrolled person's vector
}
