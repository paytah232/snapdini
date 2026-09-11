import { describe, it, expect } from 'vitest';
import { usecases } from './usecases';
import { PACKS, GENERAL_KEY, packFor } from './challenges';

describe('use-case pages', () => {
  it('every page points at a real challenge pack', () => {
    // packFor falls back to the general pack rather than throwing, so a typo in packKey would
    // quietly serve the wedding page a list of generic missions. Catch it here instead.
    for (const u of Object.values(usecases)) {
      expect(PACKS.map((p) => p.key), `${u.slug} → ${u.packKey}`).toContain(u.packKey);
      expect(u.packKey).not.toBe(GENERAL_KEY);
    }
  });

  it('no two pages show the same missions', () => {
    // The whole reason the missions are pulled per page: shared example lists would be the thin
    // duplicate content this file exists to avoid.
    const keys = Object.values(usecases).map((u) => u.packKey);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('the missions copy is written per page, not templated', () => {
    const titles = Object.values(usecases).map((u) => u.missionsTitle);
    const texts = Object.values(usecases).map((u) => u.missionsText);
    expect(titles.length).toBe(new Set(titles).size);
    expect(texts.length).toBe(new Set(texts).size);
    for (const t of texts) expect(t.length).toBeGreaterThan(120);
  });

  it('each page has enough missions to show six examples', () => {
    for (const u of Object.values(usecases)) {
      expect(packFor(u.packKey).challenges.length).toBeGreaterThanOrEqual(6);
    }
  });
});
