// A preset gallery in a fixed order silently privileges whatever happens to be first for everyone.
// Ordering it by the event's own type is only useful if it stays STABLE and never loses a design.
import { describe, it, expect } from 'vitest';
import { POSTER_PRESETS, presetForEventType, presetsForEventType, presetByKey, titleBracketFor } from './posterPresets';
import { EVENT_TYPES } from './challenges';

describe('suggesting a design for the kind of event', () => {
  it('suggests something real for every event type we offer', () => {
    // The picker's types and the poster presets are two lists maintained in different files; a type
    // added to one and not mapped in the other is a host who gets no suggestion and never knows.
    for (const t of EVENT_TYPES) {
      const p = presetForEventType(t.key);
      expect(p, `no preset mapped for event type "${t.key}"`).toBeDefined();
      expect(presetByKey(p!.key)).toBe(p);
    }
  });

  it('leaves the gallery alone when the type is unstated', () => {
    // Skipping the question is a real answer and must behave exactly as before.
    expect(presetsForEventType(null)).toEqual(POSTER_PRESETS);
    expect(presetsForEventType(undefined)).toEqual(POSTER_PRESETS);
    expect(presetsForEventType('not-a-type')).toEqual(POSTER_PRESETS);
    expect(presetForEventType(null)).toBeUndefined();
  });

  it('puts the suggestion first and keeps every other design', () => {
    const ordered = presetsForEventType('wedding');
    expect(ordered[0].key).toBe(presetForEventType('wedding')!.key);
    expect(ordered).toHaveLength(POSTER_PRESETS.length);
    // Nothing dropped and nothing duplicated — the tiles are bound by index, so a list that lost or
    // repeated an entry would paint designs onto the wrong canvases.
    expect(new Set(ordered.map((p) => p.key)).size).toBe(POSTER_PRESETS.length);
    for (const p of POSTER_PRESETS) expect(ordered).toContain(p);
  });

  it('is stable — the same type always gives the same order', () => {
    // A gallery that reshuffles between renders is one you cannot point at.
    expect(presetsForEventType('birthday').map((p) => p.key))
      .toEqual(presetsForEventType('birthday').map((p) => p.key));
  });
});

describe('the example title bracket for the kind of event', () => {
  // The field caps at 40 characters and the line is set in small tracked caps on a poster, so an
  // example longer than the field can hold is an example nobody can follow.
  const MAX = 40;

  it('offers a real pair for every event type we ship', () => {
    // Same failure mode as the preset map above: a type added to challenges.ts and not given a pair
    // here is a host shown the neutral example on a wedding sign, with nothing to say why.
    for (const t of EVENT_TYPES) {
      const b = titleBracketFor(t.key);
      expect(b.top.trim(), `no bracket top for "${t.key}"`).not.toBe('');
      expect(b.bottom.trim(), `no bracket bottom for "${t.key}"`).not.toBe('');
      expect(b.top.length).toBeLessThanOrEqual(MAX);
      expect(b.bottom.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('falls back to a neutral pair when the type is unstated or unknown', () => {
    // Skipping the event-type question is a supported answer, not a missing one.
    const neutral = titleBracketFor(null);
    expect(neutral.top.trim()).not.toBe('');
    expect(neutral.bottom.trim()).not.toBe('');
    expect(titleBracketFor(undefined)).toEqual(neutral);
    expect(titleBracketFor('not-a-type')).toEqual(neutral);
  });

  it('varies by event type rather than printing one line for everything', () => {
    // The whole point: "capture … in love" is a wedding line and is wrong on a conference sign.
    const bottoms = new Set(EVENT_TYPES.map((t) => titleBracketFor(t.key).bottom));
    expect(bottoms.size).toBeGreaterThan(1);
    expect(titleBracketFor('wedding')).not.toEqual(titleBracketFor('corporate'));
  });
});
