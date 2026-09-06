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
import path from 'node:path';

// Read lazily rather than captured at import: the kill switch is the whole safety story for this
// feature, and a module-level const means the value depends on import ORDER, which is exactly the
// kind of thing that is true in a test and false in production.
const mlUrl = (): string => (process.env.MACHINE_LEARNING_URL || '').trim().replace(/\/$/, '');
export const faceMatchingAvailable = (): boolean => !!mlUrl();

// buffalo_l (InsightFace) via Immich ML. Detection + recognition in one call.
const ENTRIES = JSON.stringify({
  'facial-recognition': {
    detection: { modelName: 'buffalo_l', options: { minScore: Number(process.env.FACE_MIN_SCORE || 0.7) } },
    recognition: { modelName: 'buffalo_l' },
  },
});

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
export async function detectFaces(imagePath: string): Promise<DetectedFace[]> {
  const ML_URL = mlUrl();
  if (!ML_URL) return [];
  try {
    if (!fs.existsSync(imagePath)) return [];
    const form = new FormData();
    form.append('entries', ENTRIES);
    form.append('image', new Blob([fs.readFileSync(imagePath)]), path.basename(imagePath));
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

/** The single enrolled face from a guest's selfie: the largest, which is the one holding the phone. */
export async function embedSelfie(imagePath: string): Promise<number[] | null> {
  const faces = await detectFaces(imagePath);
  if (!faces.length) return null;
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
