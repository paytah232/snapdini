// The shape a frame is cropped to, and the geometry of getting there.
//
// Out here rather than inside Camera.svelte because the two capture paths crop in completely
// different places and have to agree about the answer: a PHOTO is cropped into a canvas in this
// browser (cropRect, at the shutter), while a CLIP is cropped by the camera itself — an
// `aspectRatio` constraint on the track, so MediaRecorder is handed frames that are already the
// right shape. One roll holds both, and a square photo beside a not-quite-square clip is exactly
// the untidiness the frame setting exists to prevent.

/** A shape as a width/height number. 'full' is the ABSENCE of a shape rather than a ratio, so it
 *  answers null — there is nothing to compare a frame against. */
export function aspectValue(a: string): number | null {
  if (a === 'full') return null;
  const [w, h] = a.split(':').map(Number);
  return w / h;
}

/** The centre-crop of a vw×vh frame to `ratio`, as a drawImage source rect. A null ratio ('full')
 *  keeps the whole frame. Wider-than-target frames lose the sides, taller ones lose top and bottom. */
export function cropRect(vw: number, vh: number, ratio: number | null): { sx: number; sy: number; sw: number; sh: number } {
  if (ratio === null) return { sx: 0, sy: 0, sw: vw, sh: vh };
  const vr = vw / vh;
  let sw: number, sh: number;
  if (vr > ratio) { sh = vh; sw = vh * ratio; } else { sw = vw; sh = vw / ratio; }
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
}

/** How far off an exact ratio a camera may land before it counts as a different shape.
 *
 *  9:16 of a 1080-tall frame is 607.5 pixels, which no camera can deliver — it hands back 608, i.e.
 *  0.5630 against 0.5625. Relative rather than absolute, so the same slack covers a square and a 4K
 *  portrait alike, and still far tighter than the gap between any two shapes we offer. */
export const SHAPE_TOLERANCE = 0.02;

/** Did the camera actually hand back the shape it was asked for?
 *
 *  Asked separately from the asking, and that separation is the entire point. A browser may honour
 *  an `aspectRatio` constraint, refuse it outright, or accept it and quietly do nothing, and only
 *  the frame that turns up says which. So the viewfinder's framing is decided by this answer and
 *  never by the request: a viewfinder promising a crop that nothing performs is the bug that took
 *  video's framing away in the first place, and it must not come back through this door.
 *
 *  'full' answers false: it asked for no crop, so no crop was delivered and there is no shape to
 *  frame to. Same for a frame we cannot measure — an unreadable size is not a delivered one. */
export function shapeDelivered(width: number | undefined, height: number | undefined, ratio: number | null): boolean {
  if (ratio === null || !width || !height) return false;
  return Math.abs((width / height) / ratio - 1) <= SHAPE_TOLERANCE;
}
