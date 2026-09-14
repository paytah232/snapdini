// A preset gallery in a fixed order silently privileges whatever happens to be first for everyone.
// Ordering it by the event's own type is only useful if it stays STABLE and never loses a design.
import { describe, it, expect } from 'vitest';
import { POSTER_PRESETS, presetForEventType, presetsForEventType, presetByKey } from './posterPresets';
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
