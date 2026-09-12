// Lens naming is guesswork constrained by evidence, so the rule that matters is the one about when
// NOT to guess: a confidently wrong "Telephoto" is worse than a neutral "Back camera 2", especially
// on a device whose lenses we already know misbehave.
import { describe, it, expect } from 'vitest';
import { lensName, lensFacing } from './lensName';

describe('naming a camera the way a person would', () => {
  it('reads the descriptive labels iOS Safari actually gives', () => {
    expect(lensName('Back Ultra Wide Camera', 0, 4)).toBe('Back ultra-wide');
    expect(lensName('Back Telephoto Camera', 1, 4)).toBe('Back telephoto');
    expect(lensName('Back Dual Wide Camera', 2, 4)).toBe('Back wide');
    // Already a perfectly good human name — kept verbatim rather than rewritten into our own
    // phrasing. Only labels that carry no information get replaced.
    expect(lensName('Front Camera', 3, 4)).toBe('Front Camera');
    expect(lensName('Back Camera', 0, 2)).toBe('Back Camera');
  });

  it('refuses to invent a lens type from an Android label that has none', () => {
    // "camera2 0, facing back" says which way it points and nothing else. Claiming it is the
    // telephoto would be a guess presented as a fact.
    const n = lensName('camera2 0, facing back', 0, 4);
    expect(n).toBe('Back camera 1');
    expect(n).not.toMatch(/tele|ultra|wide/i);
  });

  it('still uses the side when that is all the label knows', () => {
    expect(lensName('camera2 1, facing front', 1, 4)).toBe('Front camera 2');
    // With only two cameras there is no need to number them.
    expect(lensName('camera2 0, facing back', 0, 2)).toBe('Back camera');
  });

  it('keeps a real human name the device gave us', () => {
    expect(lensName('FaceTime HD Camera', 0, 1)).toBe('FaceTime HD Camera');
    expect(lensName('Logitech BRIO', 0, 2)).toBe('Logitech BRIO');
  });

  it('falls back to a number when there is no label at all', () => {
    // Labels are empty until permission is granted, which is exactly when the picker first renders.
    expect(lensName('', 0, 3)).toBe('Camera 1');
    expect(lensName('   ', 2, 3)).toBe('Camera 3');
    expect(lensName('', 0, 1)).toBe('Camera');
  });

  it('does not read "face" in FaceTime as a front-facing claim it then contradicts', () => {
    // FaceTime HD IS front-facing, so either answer is defensible — what must not happen is a
    // mangled hybrid. Whatever it returns has to be a clean, sensible name.
    const n = lensName('FaceTime HD Camera', 0, 1);
    expect(n).toMatch(/^(FaceTime HD Camera|Front camera)$/);
  });

  it('shortens an unwieldy vendor string rather than overflowing the picker', () => {
    const long = 'Integrated RGB and Infrared Rear Facing Camera Module (1bcf:2c99)';
    expect(lensName(long, 1, 3)).toBe('Back camera 2');
  });

  it('reads which way a lens points, and admits when it cannot', () => {
    expect(lensFacing('Back Ultra Wide Camera')).toBe('environment');
    expect(lensFacing('camera2 1, facing front')).toBe('user');
    expect(lensFacing('FaceTime HD Camera')).toBe('user');
    expect(lensFacing('Logitech BRIO')).toBe('');
    expect(lensFacing('')).toBe('');
  });

  it('never returns an empty name', () => {
    for (const l of ['', '   ', 'x', 'camera2 0, facing back', 'Back Telephoto Camera']) {
      expect(lensName(l, 0, 4).length).toBeGreaterThan(0);
    }
  });
});
