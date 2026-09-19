import { describe, it, expect } from 'vitest';
import {
  PACKS, MOODS, ALL_BY_ID, CHALLENGE_MAX_LEN, DEFAULT_COUNT, MAX_COUNT,
  packFor, pickChallenges, customChallenge, isCustomId, type Mood,
  CLIP_TRICKS_ENABLED, offeredChallenges,
  TICKS_OUTLINE, TICKS_EMOJI, DEFAULT_TICK, tickFor, cleanTick, varySets, varyOne, MAX_SETS,
  missionsSavedMessage,
} from './challenges';

// Seeded so "shuffle" is deterministic here — a flaky content test is worse than no test.
const seeded = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

describe('the library itself', () => {
  it('covers every event type we market a landing page for, plus a general default', () => {
    expect(PACKS.map((p) => p.key).sort()).toEqual(
      ['baby-shower', 'birthday', 'christmas', 'corporate', 'engagement', 'general', 'graduation', 'hens', 'travel', 'wedding']);
  });
  it('the general pack assumes nothing about the occasion', () => {
    // It is the default for an event with no declared type, so a mention of a cake or a couple
    // would land on a reunion or a wake.
    const text = packFor('general').challenges.map((c) => c.text).join(' ').toLowerCase();
    for (const word of ['cake', 'couple', 'bride', 'groom', 'wedding', 'birthday', 'baby', 'graduate']) {
      expect(text, `general pack mentions "${word}"`).not.toContain(word);
    }
  });
  it('ids are unique ACROSS packs — they are stored on photos and counted', () => {
    const ids = PACKS.flatMap((p) => p.challenges.map((c) => c.id));
    expect(ids.length).toBe(new Set(ids).size);
    expect(Object.keys(ALL_BY_ID).length).toBe(ids.length);
  });
  it('no id could be mistaken for a host’s own', () => {
    for (const id of Object.keys(ALL_BY_ID)) expect(isCustomId(id)).toBe(false);
  });
  it('ids are url/db-safe, so they can live in a query string or a column', () => {
    for (const id of Object.keys(ALL_BY_ID)) expect(id).toMatch(/^[a-z][a-z0-9-]{2,39}$/);
  });
  it('every challenge fits a printed card line', () => {
    const over = Object.values(ALL_BY_ID).filter((c) => c.text.length > CHALLENGE_MAX_LEN);
    expect(over.map((c) => `${c.id}:${c.text.length}`)).toEqual([]);
  });
  it('every challenge carries at least one mood, from the known set', () => {
    const known = new Set(MOODS.map((m) => m.key));
    for (const c of Object.values(ALL_BY_ID)) {
      expect(c.moods.length).toBeGreaterThan(0);
      for (const m of c.moods) expect(known.has(m)).toBe(true);
    }
  });
  it('every pack can fill the default list from its classics alone', () => {
    // The no-mood default is the curated order, so the first N must be the ones worth having.
    for (const p of PACKS) {
      expect(p.challenges.filter((c) => c.moods.includes('classic')).length).toBeGreaterThanOrEqual(4);
    }
  });
  it('every mood is usable in every pack — a theme button must never come back empty', () => {
    for (const p of PACKS) {
      for (const m of MOODS.map((x) => x.key)) {
        const n = p.challenges.filter((c) => c.moods.includes(m)).length;
        expect(n, `${p.key} has no "${m}" challenges`).toBeGreaterThan(0);
      }
    }
  });
  it('every pack offers more than the maximum a host can pick, so there is real choice', () => {
    for (const p of PACKS) expect(p.challenges.length).toBeGreaterThanOrEqual(MAX_COUNT);
  });
  it('shows at most one clip prompt in the first six', () => {
    // The first six ARE the examples on each landing page, and a page of clip prompts misrepresents
    // a product whose default event allows no video at all.
    for (const p of PACKS) {
      const clips = p.challenges.slice(0, 6).filter((c) => c.video).length;
      expect(clips, `${p.key} leads with ${clips} clip prompts`).toBeLessThanOrEqual(1);
    }
  });
  it('packs are mostly stills — a roll of video prompts would eat the allowance', () => {
    for (const p of PACKS) {
      const vids = p.challenges.filter((c) => c.video).length;
      expect(vids / p.challenges.length).toBeLessThan(0.35);
    }
  });
});

describe('clip tricks are hidden', () => {
  // A trick is a PHOTO prompt: finalizeUpload drops challengeId from any video upload, so a
  // clip-tagged trick on a host’s card promises something the app then refuses. The content stays
  // (ids live on photos for the life of the product) and only the OFFER is switched off.
  it('ships with the switch off — flip CLIP_TRICKS_ENABLED to offer them again', () => {
    // The single place that fails if someone turns clip tricks back on. That is a product
    // decision, and this is where it gets recorded.
    expect(CLIP_TRICKS_ENABLED).toBe(false);
  });
  it('keeps the content, so an event saved when they were on can still resolve its ids', () => {
    const clips = Object.values(ALL_BY_ID).filter((c) => c.video);
    expect(clips.length).toBeGreaterThan(0);
    for (const p of PACKS) expect(p.challenges.some((c) => c.video), p.key).toBe(true);
  });
  it('offers no clip prompt from any pack, whatever the event allows', () => {
    for (const p of PACKS) {
      expect(offeredChallenges(p, true).some((c) => c.video), p.key).toBe(false);
      expect(offeredChallenges(p, false).some((c) => c.video), p.key).toBe(false);
    }
  });
  it('no picker can hand a host one either — the gate is in offeredChallenges, not the callers', () => {
    for (const p of PACKS) {
      const one = pickChallenges(p, { count: MAX_COUNT, allowVideo: true, maxVideo: 99, rng: seeded(71) });
      expect(one.some((c) => c.video), p.key).toBe(false);
      for (const set of varySets(p, { sets: 3, count: MAX_COUNT, allowVideo: true, maxVideo: 99, rng: seeded(72) })) {
        expect(set.items.some((c) => c.video), p.key).toBe(false);
      }
      const more = varyOne(p, [one], { count: MAX_COUNT, allowVideo: true, maxVideo: 99, rng: seeded(73) });
      expect(more.some((c) => c.video), p.key).toBe(false);
    }
  });
  it('leaves every pack with more than a host can pick, so nothing is thinned out', () => {
    // The reason hiding is safe at all: the thinnest pack still has more stills than MAX_COUNT.
    for (const p of PACKS) expect(offeredChallenges(p).length, p.key).toBeGreaterThanOrEqual(MAX_COUNT);
  });
  it('leaves every mood usable in every pack — no quick pick comes back empty', () => {
    for (const p of PACKS) {
      for (const m of MOODS.map((x) => x.key)) {
        const n = offeredChallenges(p).filter((c) => c.moods.includes(m)).length;
        expect(n, `${p.key} has no still "${m}" tricks`).toBeGreaterThan(0);
        expect(pickChallenges(p, { mood: m, count: MAX_COUNT, rng: seeded(74) }), `${p.key}/${m}`)
          .toHaveLength(MAX_COUNT);
      }
    }
  });
  it('still honours the per-event rule underneath, so flipping the switch back is enough', () => {
    // offeredChallenges ANDs the two gates. Proven on the non-video side: allowVideo false must
    // strip clips no matter what the product switch says.
    const wedding = packFor('wedding');
    expect(offeredChallenges(wedding, false).every((c) => !c.video)).toBe(true);
    expect(offeredChallenges(wedding, false).length).toBe(wedding.challenges.filter((c) => !c.video).length);
  });
});

describe('pickChallenges', () => {
  const wed = packFor('wedding')!;
  it('defaults to five, in curated order', () => {
    const got = pickChallenges(wed);
    expect(got).toHaveLength(DEFAULT_COUNT);
    expect(got.map((c) => c.id)).toEqual(wed.challenges.slice(0, 5).map((c) => c.id));
  });
  it('honours the host’s count, up and down — their call, not ours', () => {
    expect(pickChallenges(wed, { count: 1 })).toHaveLength(1);
    expect(pickChallenges(wed, { count: 3 })).toHaveLength(3);
    expect(pickChallenges(wed, { count: 12 })).toHaveLength(12);
  });
  it('clamps nonsense rather than throwing', () => {
    expect(pickChallenges(wed, { count: 0 })).toHaveLength(1);
    expect(pickChallenges(wed, { count: 999 })).toHaveLength(MAX_COUNT);
    expect(pickChallenges(wed, { count: 4.7 })).toHaveLength(4);
  });
  it('never repeats a challenge', () => {
    for (const m of [null, ...MOODS.map((x) => x.key)] as (Mood | null)[]) {
      const ids = pickChallenges(wed, { count: MAX_COUNT, mood: m, rng: seeded(7) }).map((c) => c.id);
      expect(ids.length).toBe(new Set(ids).size);
    }
  });
  it('a mood prefers its own challenges', () => {
    const got = pickChallenges(wed, { mood: 'silly', count: 2, rng: seeded(3) });
    expect(got.every((c) => c.moods.includes('silly'))).toBe(true);
  });
  it('but still returns the full count from a thinly-tagged mood', () => {
    for (const p of PACKS) {
      for (const m of MOODS.map((x) => x.key)) {
        expect(pickChallenges(p, { mood: m, count: 8, rng: seeded(11) }),
          `${p.key}/${m}`).toHaveLength(8);
      }
    }
  });
  it('shuffle with no mood draws at RANDOM, not the curated order', () => {
    // The bug this covers: with mood:null the picker returned the pack's curated order, which is the
    // list the host is already looking at — so the Shuffle button appeared to do nothing at all.
    const plain = pickChallenges(wed, { count: 6 }).map((c) => c.id);
    const a = pickChallenges(wed, { count: 6, shuffle: true, rng: seeded(41) }).map((c) => c.id);
    const b = pickChallenges(wed, { count: 6, shuffle: true, rng: seeded(97) }).map((c) => c.id);
    expect(a).not.toEqual(plain);
    expect(a).not.toEqual(b);
    expect(new Set(a).size).toBe(6);
  });
  it('shuffling still respects the count, the video rules and the pack', () => {
    for (const p of PACKS) {
      const got = pickChallenges(p, { count: MAX_COUNT, shuffle: true, allowVideo: false, rng: seeded(43) });
      expect(got, p.key).toHaveLength(MAX_COUNT);
      expect(got.some((c) => c.video), p.key).toBe(false);
      for (const c of got) expect(p.challenges.some((x) => x.id === c.id), `${p.key}/${c.id}`).toBe(true);
    }
  });
  it('shuffles within a mood, so a mood pick changes something', () => {
    const a = pickChallenges(wed, { mood: 'heartfelt', count: 3, rng: seeded(1) }).map((c) => c.id);
    const b = pickChallenges(wed, { mood: 'heartfelt', count: 3, rng: seeded(99) }).map((c) => c.id);
    expect(a).not.toEqual(b);
  });
  it('excludes clip prompts entirely when the event allows no video', () => {
    // videoMaxSeconds can be 0 — a mission a guest physically cannot complete is a dead line.
    for (const p of PACKS) {
      for (const m of [null, ...MOODS.map((x) => x.key)] as (Mood | null)[]) {
        const got = pickChallenges(p, { mood: m, count: MAX_COUNT, allowVideo: false, rng: seeded(5) });
        expect(got.some((c) => c.video), `${p.key}/${m}`).toBe(false);
        expect(got.length, `${p.key}/${m}`).toBe(MAX_COUNT);
      }
    }
  });
  it('caps clip prompts by default', () => {
    const got = pickChallenges(wed, { count: MAX_COUNT, rng: seeded(2) });
    expect(got.filter((c) => c.video).length).toBeLessThanOrEqual(2);
  });
  it('relaxes the clip cap rather than handing back a short list', () => {
    const got = pickChallenges(wed, { count: MAX_COUNT, maxVideo: 0, rng: seeded(4) });
    expect(got).toHaveLength(MAX_COUNT);
  });
});

describe('a host’s own wording', () => {
  it('is accepted, tidied and given a non-colliding id', () => {
    const c = customChallenge('  The   dog   in a bow tie ', 1);
    expect(c).toEqual({ id: 'own-1', text: 'The dog in a bow tie', moods: [] });
    expect(isCustomId(c!.id)).toBe(true);
    expect(ALL_BY_ID[c!.id]).toBeUndefined();
  });
  it('is refused when empty or too long for the card', () => {
    expect(customChallenge('   ', 1)).toBeNull();
    expect(customChallenge('x'.repeat(CHALLENGE_MAX_LEN + 1), 1)).toBeNull();
    expect(customChallenge('x'.repeat(CHALLENGE_MAX_LEN), 1)).not.toBeNull();
  });
});

describe('packFor', () => {
  it('finds a pack by key', () => expect(packFor('wedding')?.label).toBe('Wedding'));
  it('falls back to the general pack rather than leaving a host with nothing', () => {
    for (const k of ['funeral', 'christening', '', null, undefined]) {
      expect(packFor(k as string).key).toBe('general');
    }
  });
});

describe('the tick box on the card', () => {
  it('gives every pack a default, and it is a single character', () => {
    for (const p of PACKS) expect([...tickFor(p.key)], `${p.key} tick`).toHaveLength(1);
  });
  it('suits the occasion — a heart for a wedding, a bottle for a baby shower', () => {
    expect(tickFor('wedding')).toBe('\u2661');
    expect(tickFor('baby-shower')).toBe('\u{1F37C}');
    expect(tickFor('graduation')).toBe('\u{1F393}');
  });
  it('falls back to a plain circle for anything unstated', () => {
    for (const k of [null, undefined, '', 'funeral']) expect(tickFor(k)).toBe('\u25CB');
  });
  it('every default is one of the offered options, so the picker can show it selected', () => {
    const offered = new Set<string>([...TICKS_OUTLINE, ...TICKS_EMOJI]);
    for (const [k, t] of Object.entries(DEFAULT_TICK)) expect(offered.has(t), `${k}`).toBe(true);
  });
  it('accepts a host’s own single character, emoji included', () => {
    expect(cleanTick('\u2605')).toBe('\u2605');
    expect(cleanTick(' \u2665 ')).toBe('\u2665');
    // Two UTF-16 units but ONE character — .length would wrongly reject this.
    expect(cleanTick('\u{1F408}')).toBe('\u{1F408}');
  });
  it('refuses anything that would break the card row height', () => {
    const bads = ['', '  ', 'ab', '\u2661\u2661', String.fromCharCode(10), String.fromCharCode(9), null, undefined];
    for (const bad of bads) expect(cleanTick(bad as string), JSON.stringify(bad)).toBeNull();
  });
});

describe('varySets — several cards that differ, but not completely', () => {
  const wed = packFor('wedding');
  it('makes the number of cards asked for, each with the right count', () => {
    const sets = varySets(wed, { sets: 4, count: 6, rng: seeded(21) });
    expect(sets).toHaveLength(4);
    for (const s of sets) expect(s.items).toHaveLength(6);
  });
  it('gives every card the same core, so the must-haves cannot be missed', () => {
    // The failure this prevents: the cake ends up on one card out of six and nobody shoots it.
    const sets = varySets(wed, { sets: 5, count: 6, shared: 2, rng: seeded(22) });
    const firstTwo = sets[0].items.slice(0, 2).map((c) => c.id);
    for (const s of sets) expect(s.items.slice(0, 2).map((c) => c.id)).toEqual(firstTwo);
  });
  it('and genuinely differs beyond the core', () => {
    const sets = varySets(wed, { sets: 3, count: 6, shared: 2, rng: seeded(23) });
    const tails = sets.map((s) => s.items.slice(2).map((c) => c.id).join(','));
    expect(new Set(tails).size).toBe(3);
  });
  it('never repeats a challenge within one card', () => {
    for (const p of PACKS) {
      for (const s of varySets(p, { sets: MAX_SETS, count: 10, rng: seeded(24) })) {
        expect(new Set(s.items.map((c) => c.id)).size, p.key).toBe(s.items.length);
      }
    }
  });
  it('keys and labels are unique and URL-safe — they end up in a QR link', () => {
    const sets = varySets(wed, { sets: MAX_SETS, count: 5, rng: seeded(25) });
    expect(new Set(sets.map((s) => s.key)).size).toBe(MAX_SETS);
    for (const s of sets) expect(s.key).toMatch(/^[a-z0-9]{1,8}$/);
  });
  it('clamps an absurd number of cards', () => {
    expect(varySets(wed, { sets: 99, count: 5 }).length).toBe(MAX_SETS);
    expect(varySets(wed, { sets: 0, count: 5 }).length).toBe(1);
  });
  it('honours no-video events on every card', () => {
    for (const p of PACKS) {
      for (const s of varySets(p, { sets: 4, count: 10, allowVideo: false, rng: seeded(26) })) {
        expect(s.items.some((c) => c.video), p.key).toBe(false);
        expect(s.items, p.key).toHaveLength(10);
      }
    }
  });
  it('still fills every card when a mood is chosen', () => {
    for (const m of MOODS.map((x) => x.key)) {
      for (const s of varySets(wed, { sets: 3, count: 8, mood: m, rng: seeded(27) })) {
        expect(s.items, m).toHaveLength(8);
      }
    }
  });
});

describe('varyOne — adding a card', () => {
  const wed = packFor('wedding');
  it('does NOT duplicate the card that already exists', () => {
    // The bug: adding a card called the curated picker, so card B came out identical to card A.
    const a = pickChallenges(wed, { count: 5 });
    const bNew = varyOne(wed, [a], { count: 5, rng: seeded(51) });
    expect(bNew.map((c) => c.id)).not.toEqual(a.map((c) => c.id));
  });
  it('keeps a shared core, so the must-haves are on both', () => {
    const a = pickChallenges(wed, { count: 6 });
    const bNew = varyOne(wed, [a], { count: 6, shared: 2, rng: seeded(52) });
    expect(bNew.slice(0, 2).map((c) => c.id)).toEqual(a.slice(0, 2).map((c) => c.id));
  });
  it('prefers challenges no existing card is already using', () => {
    const a = pickChallenges(wed, { count: 5 });
    const bNew = varyOne(wed, [a], { count: 5, shared: 1, rng: seeded(53) });
    const overlap = bNew.slice(1).filter((c) => a.some((x) => x.id === c.id));
    expect(overlap).toHaveLength(0);
  });
  it('follows the HOST’s core once they have reworked their cards', () => {
    // Two existing cards that share a deliberate pair the host chose; a third should agree with
    // their version, not with our curated order.
    const shared2 = wed.challenges.slice(8, 10);
    const a = [...shared2, ...wed.challenges.slice(2, 5)];
    const b = [...shared2, ...wed.challenges.slice(12, 15)];
    const c = varyOne(wed, [a, b], { count: 5, shared: 2, rng: seeded(54) });
    expect(c.slice(0, 2).map((x) => x.id)).toEqual(shared2.map((x) => x.id));
  });
  it('always returns the count asked for, video rules respected', () => {
    for (const p of PACKS) {
      const a = pickChallenges(p, { count: 8, allowVideo: false });
      const got = varyOne(p, [a], { count: 8, allowVideo: false, rng: seeded(55) });
      expect(got, p.key).toHaveLength(8);
      expect(got.some((x) => x.video), p.key).toBe(false);
      expect(new Set(got.map((x) => x.id)).size, p.key).toBe(8);
    }
  });
});

// ── What a save tells the host ───────────────────────────────────────

describe('missionsSavedMessage', () => {
  it('says nothing extra on a save that moved nobody', () => {
    // Which is every save that only added or reworded a trick — the common case.
    expect(missionsSavedMessage({ sets: 2, reseated: 0 })).toBe('Saved \u2014 2 cards ready to print');
    expect(missionsSavedMessage({ sets: 1, reseated: 0 })).toBe('Saved \u2014 1 card ready to print');
    expect(missionsSavedMessage({ sets: 0, reseated: 0 })).toBe('Trick list cleared');
  });

  it('names the guests a deleted card moved', () => {
    // The server counts them (`reseated`) precisely because the host cannot see it from the editor:
    // those guests are holding a printed card and will be asked which one again, mid-event.
    const m = missionsSavedMessage({ sets: 2, reseated: 5 });
    expect(m).toContain('5 guests');
    expect(m).toContain('which card');
  });

  it('counts one guest as one', () => {
    expect(missionsSavedMessage({ sets: 2, reseated: 1 })).toContain('1 guest will be asked');
  });

  it('says there is no card left when the list is cleared', () => {
    expect(missionsSavedMessage({ sets: 0, reseated: 3 }))
      .toBe('Trick list cleared \u2014 3 guests no longer have a card');
    expect(missionsSavedMessage({ sets: 0, reseated: 1 }))
      .toBe('Trick list cleared \u2014 1 guest no longer has a card');
  });

  it('is not fooled by a server that omits the count', () => {
    expect(missionsSavedMessage({ sets: 2, reseated: NaN })).toBe('Saved \u2014 2 cards ready to print');
  });
});
