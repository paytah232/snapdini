// The panel's two promises to a host who has just pressed Generate.
//
// It used to HIDE the Generate button for the whole render, which is where "I touched a setting and
// it threw it away" comes from: a host who changed something mid-encode had nowhere to put it, and
// on a phone — where the poll is suspended the moment the screen locks, so `status` is whatever it
// was minutes ago — the button was often still showing, and pressing it posted the new settings
// into a server that quietly handed back the render already running. These pin the button staying
// put, the settings actually travelling with the press, and the cap saying what it is doing.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

const getSlideshow = vi.fn();
const startSlideshowJob = vi.fn();
const showToast = vi.fn();

vi.mock('$lib/events', () => ({
  getSlideshow: (...a: unknown[]) => getSlideshow(...a),
  startSlideshowJob: (...a: unknown[]) => startSlideshowJob(...a),
  uploadSlideshowAudio: vi.fn(),
  favouriteSlideshow: vi.fn(),
  deleteSlideshowVersion: vi.fn(),
  slideshowDownloadUrl: () => '#',
  buyBrandingRemoval: vi.fn(),
}));
vi.mock('$lib/toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import SlideshowPanel from './SlideshowPanel.svelte';

type Status = Record<string, unknown>;
const status = (over: Status = {}): Status => ({
  status: 'idle', music: [], photoCount: 92, favouriteCount: 5, videoCount: 0,
  hasCustomAudio: false, secondsPerDefault: 3, recent: [], qualities: [],
  // The real measured numbers from the container: 4K encodes at ~1x real time and pre-scales at
  // 0.19 s/item; 1080p at 0.35x and 0.07 s/item.
  resolutions: [{ id: '4k', label: '4K', sizeScale: 3, renderScale: 1, prepPerItem: 0.19 },
                { id: '1080p', label: '1080p', sizeScale: 1, renderScale: 0.35, prepPerItem: 0.07 }],
  queued: [], maxQueue: 3, ...over,
});

async function mount() {
  const r = render(SlideshowPanel, { props: { code: 'abc', orgCode: 'org', hasPhotos: true } });
  await new Promise((res) => setTimeout(res, 0));   // let onMount's await refresh() land
  await tick();
  return r;
}
const flat = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Just the time the panel quotes, out of the sentence it sits in. */
const quoted = (container: Element): string => {
  const line = flat(container.querySelector('.how-long'));
  const m = line.match(/Building it takes (.+?), and it runs/);
  if (!m) throw new Error(`no time quote in: ${line || '(no .how-long at all)'}`);
  return m[1];
};
/** The same quote as a number of minutes, so two of them can be compared. Anything the panel says
 *  that is not one of the three shapes it is allowed to say fails here rather than being counted. */
const quotedMinutes = (phrase: string): number => {
  if (phrase === 'a minute or two') return 2;
  const hours = phrase.match(/^about ([\d.]+) hours?$/);
  if (hours) return Number(hours[1]) * 60;
  const mins = phrase.match(/^about (\d+) minutes$/);
  if (mins) return Number(mins[1]);
  throw new Error(`the panel quoted a time in a shape nothing here recognises: ${JSON.stringify(phrase)}`);
};
const quoteFor = async (over: Record<string, unknown>) => {
  getSlideshow.mockResolvedValue(status(over));
  const { container, unmount } = await mount();
  const q = quoted(container);
  unmount();
  return q;
};

beforeEach(() => {
  getSlideshow.mockReset();
  startSlideshowJob.mockReset().mockResolvedValue({ status: 'running', queuedCount: 0 });
  showToast.mockReset();
});

describe('nothing is capped, and the wait is stated up front', () => {
  it('promises every item goes in, however many there are', async () => {
    getSlideshow.mockResolvedValue(status({ photoCount: 300 }));
    const { container } = await mount();
    expect(flat(container.querySelector('.how-long'))).toContain('All 300 of them go in');
  });
  it('says roughly how long, in minutes rather than to the second', async () => {
    // 92 stills at 3s ≈ 221s of film; ×1.0 to encode plus 92×0.19s to pre-scale ≈ 4 minutes.
    expect(await quoteFor({})).toMatch(/^about \d+ minutes$/);
  });
  it('a handful of photos is not dressed up as a wait', async () => {
    expect(await quoteFor({ photoCount: 4 })).toBe('a minute or two');
  });
  it('a big roll is quoted in hours — one hour, not "60 minutes" and not "1 hours"', async () => {
    // Both of these used to assert only that the words "hours" appeared somewhere, which the same
    // branch satisfies at any size. The number and its plural are the part a host reads.
    expect(await quoteFor({ photoCount: 1500 })).toBe('about 1 hour');
  });
  it('and a bigger one still is quoted in whole hours, plural', async () => {
    expect(await quoteFor({ photoCount: 2500 })).toBe('about 2 hours');
  });
  it('never quotes an hour as sixty minutes — it changes over exactly once, into one hour', async () => {
    // The untested edge. roughTime switches units at 60 ROUNDED minutes, so 59.5 minutes of work
    // must come out as "about 1 hour" and not "about 60 minutes"; the sweep brackets the crossover
    // rather than hardcoding the photo count it happens to fall on today.
    const counts = [1, 50, 500, 1000, 1200, 1350, 1370, 1377, 1378, 1400, 1500, 2500];
    const quotes: string[] = [];
    for (const photoCount of counts) quotes.push(await quoteFor({ photoCount }));

    for (const q of quotes) {
      if (/minutes/.test(q)) expect(quotedMinutes(q), `"${q}" should have been an hour`).toBeLessThan(60);
    }
    const mins = quotes.map(quotedMinutes);
    for (let i = 1; i < mins.length; i++) {
      expect(mins[i], `${counts[i]} photos quoted less time than ${counts[i - 1]}: ${quotes[i]} vs ${quotes[i - 1]}`)
        .toBeGreaterThanOrEqual(mins[i - 1]);
    }
    const crossover = quotes.findIndex((q) => /hour/.test(q));
    expect(crossover, `the sweep never reached the hours branch: ${quotes.join(' | ')}`).toBeGreaterThan(0);
    expect(quotes[crossover]).toBe('about 1 hour');
    expect(quotes.slice(crossover).every((q) => /hour/.test(q)),
      `it went back to minutes after quoting hours: ${quotes.join(' | ')}`).toBe(true);
  });
  it('4K over an all-1080p event is quoted, and explained, as a 1080p render', async () => {
    getSlideshow.mockResolvedValue(status({ sourcesFitIn1080: true }));
    const { container } = await mount();
    expect(flat(container.querySelector('.how-long'))).toMatch(/renders at\s*1080p/i);
  });
  it('and says nothing about it when a photo really is bigger', async () => {
    getSlideshow.mockResolvedValue(status({ sourcesFitIn1080: false }));
    const { container } = await mount();
    expect(flat(container.querySelector('.how-long'))).not.toMatch(/renders at\s*1080p/i);
  });
  it('the cheaper resolution is quoted as quicker', async () => {
    // Not merely "different": a regression that quoted 1080p as SLOWER than 4K passed the old
    // .not.toBe(), and 1080p being the cheap option is the whole reason the panel offers it.
    // 400 stills puts both resolutions in the minutes band, so the two are directly comparable.
    getSlideshow.mockResolvedValue(status({ photoCount: 400 }));
    const { container } = await mount();
    const at4k = quoted(container);
    await fireEvent.change(screen.getByDisplayValue('4K'), { target: { value: '1080p' } });
    const at1080 = quoted(container);
    expect(quotedMinutes(at1080), `1080p quoted ${at1080} against 4K's ${at4k}`)
      .toBeLessThan(quotedMinutes(at4k));
    // And quicker BY THE MEASUREMENT, not by a rounding. The server reports 1080p at 0.35x the 4K
    // rate; a quote that only differs by the per-item pre-scale has dropped renderScale on the
    // floor and is still, just barely, "less".
    expect(quotedMinutes(at1080), `1080p (${at1080}) is barely under 4K (${at4k}) — renderScale looks ignored`)
      .toBeLessThan(quotedMinutes(at4k) * 0.6);
  });
});

describe('order', () => {
  it('defaults to the night in the order it happened', async () => {
    getSlideshow.mockResolvedValue(status());
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: /generate slideshow/i }));
    expect(startSlideshowJob).toHaveBeenCalledWith('abc', 'org',
      expect.objectContaining({ order: 'chronological' }));
  });
  it('sends the shuffle when it is picked', async () => {
    getSlideshow.mockResolvedValue(status());
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: /shuffled/i }));
    await fireEvent.click(screen.getByRole('button', { name: /generate slideshow/i }));
    expect(startSlideshowJob).toHaveBeenCalledWith('abc', 'org',
      expect.objectContaining({ order: 'shuffled' }));
  });
});

describe('a render that is already going', () => {
  it('shows a bar that reports the encode percentage', async () => {
    getSlideshow.mockResolvedValue(status({ status: 'running', phase: 'encoding', progress: 12 }));
    const { container } = await mount();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('12');
  });
  it('reports no percentage at all while collecting, rather than a stuck zero', async () => {
    getSlideshow.mockResolvedValue(status({ status: 'running', phase: 'collecting', progress: 0 }));
    const { container } = await mount();
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-valuenow')).toBeNull();
  });
  it('promises the render survives the page going away', async () => {
    getSlideshow.mockResolvedValue(status({ status: 'running', phase: 'encoding', progress: 40 }));
    const { container } = await mount();
    expect(flat(container.querySelector('.bg-note'))).toMatch(/keeps rendering on our server/i);
  });
  it('keeps the button, so a changed setting has somewhere to go', async () => {
    getSlideshow.mockResolvedValue(status({ status: 'running', phase: 'encoding', progress: 40 }));
    await mount();
    const btn = screen.getByRole('button', { name: /queue another render/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
  it('queues the settings on screen now, and says so', async () => {
    getSlideshow.mockResolvedValue(status({ status: 'running', phase: 'encoding', progress: 40 }));
    startSlideshowJob.mockResolvedValue({ status: 'running', queuedCount: 1 });
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: /shuffled/i }));
    await fireEvent.click(screen.getByRole('button', { name: /queue another render/i }));
    expect(startSlideshowJob).toHaveBeenCalledWith('abc', 'org',
      expect.objectContaining({ order: 'shuffled' }));
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/queued/i));
  });
  it('lists what is waiting behind it', async () => {
    getSlideshow.mockResolvedValue(status({
      status: 'running', phase: 'encoding', progress: 40,
      queued: [{ id: 'q1', label: 'All photos · 4s/photo · shuffled', queuedAt: Date.now() }],
    }));
    const { container } = await mount();
    expect(flat(container.querySelector('.queued'))).toContain('All photos · 4s/photo · shuffled');
  });
  it('stops taking more once the queue is full, and says why', async () => {
    getSlideshow.mockResolvedValue(status({
      status: 'running', phase: 'encoding', progress: 40, maxQueue: 2,
      queued: [
        { id: 'q1', label: 'All photos · 3s/photo', queuedAt: Date.now() },
        { id: 'q2', label: 'Favourites · 3s/photo', queuedAt: Date.now() },
      ],
    }));
    const { container } = await mount();
    const btn = screen.getByRole('button', { name: /queue another render/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(flat(container).toLowerCase()).toContain('2 renders are already waiting');
  });
});


describe('favourite video clips are offered, not dropped', () => {
  // A favourites render strips videos before the favourite filter runs, so a starred clip used to
  // vanish with nothing said. The offer has to name them, or there is no reason to connect a
  // generic "include video clips" tickbox to the clips you starred.
  const favs = (over = {}) => status({ favouriteCount: 9, videoCount: 4, favouriteVideoCount: 3, ...over });
  const toFavourites = async () => fireEvent.click(screen.getByRole('button', { name: /favourites/i }));

  it('says how many of the favourites are clips', async () => {
    getSlideshow.mockResolvedValue(favs());
    const { container } = await mount();
    await toFavourites();
    expect(flat(container.querySelector('.chk.offer')))
      .toContain('3 of your favourites are video clips — include them?');
  });
  it('reads as one clip when there is one', async () => {
    getSlideshow.mockResolvedValue(favs({ favouriteVideoCount: 1 }));
    const { container } = await mount();
    await toFavourites();
    expect(flat(container.querySelector('.chk.offer')))
      .toContain('1 of your favourites is a video clip — include it?');
  });
  it('is not offered when none of the favourites are clips', async () => {
    getSlideshow.mockResolvedValue(favs({ favouriteVideoCount: 0 }));
    const { container } = await mount();
    await toFavourites();
    expect(container.querySelector('.chk.offer')).toBeNull();
  });
  it('accepting it actually puts them in the render', async () => {
    getSlideshow.mockResolvedValue(favs());
    const { container } = await mount();
    await toFavourites();
    expect(flat(container.querySelector('.how-long'))).toContain('All 9 of them go in');
    await fireEvent.click(container.querySelector('.chk.offer input') as HTMLInputElement);
    expect(flat(container.querySelector('.how-long'))).toContain('All 12 of them go in');
    await fireEvent.click(screen.getByRole('button', { name: /generate slideshow/i }));
    expect(startSlideshowJob).toHaveBeenCalledWith('abc', 'org',
      expect.objectContaining({ favouritesOnly: true, includeVideos: true }));
  });
  it('and only then offers to keep their sound', async () => {
    getSlideshow.mockResolvedValue(favs());
    const { container } = await mount();
    await toFavourites();
    expect(container.querySelector('.chk.sub')).toBeNull();
    await fireEvent.click(container.querySelector('.chk.offer input') as HTMLInputElement);
    expect(flat(container.querySelector('.chk.sub'))).toContain("Keep the clips' sound");
  });
});

describe('track lengths come from the server', () => {
  // They used to be read in the browser from <audio preload="metadata">, which never fires on iOS
  // without a gesture — so on an iPhone every length was simply missing.
  const withMusic = status({ music: [{ id: 'c0-a.mp3', label: 'Funkorama', secs: 125 }], customAudioSecs: 90 });

  it('shows a track length without ever touching an <audio> element', async () => {
    getSlideshow.mockResolvedValue(withMusic);
    const { container } = await mount();
    expect(flat(container.querySelector('.tracks'))).toMatch(/Funkorama\s+· 2m 5s/);
  });
  it('totals the chosen tracks from what the server said', async () => {
    getSlideshow.mockResolvedValue(withMusic);
    const { container } = await mount();
    expect(flat(container.querySelector('.chosen'))).toContain('2m 5s of music');
  });
  it('a track whose length the server could not read simply has none', async () => {
    getSlideshow.mockResolvedValue(status({ music: [{ id: 'c0-a.mp3', label: 'Funkorama' }] }));
    const { container } = await mount();
    expect(flat(container.querySelector('.tracks'))).toContain('Funkorama');
    expect(flat(container.querySelector('.chosen'))).not.toMatch(/of music/);
  });
});
