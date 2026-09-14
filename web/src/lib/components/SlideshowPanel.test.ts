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
    getSlideshow.mockResolvedValue(status());
    const { container } = await mount();
    const line = flat(container.querySelector('.how-long'));
    expect(line).toMatch(/about \d+ minutes/);
    expect(line).not.toMatch(/\d+ seconds/);
  });
  it('a big roll is quoted in hours, not in 90 minutes of minutes', async () => {
    getSlideshow.mockResolvedValue(status({ photoCount: 1500 }));
    const { container } = await mount();
    expect(flat(container.querySelector('.how-long'))).toMatch(/about [\d.]+ hours?\b/);
  });
  it('and past an hour it stays in hours', async () => {
    getSlideshow.mockResolvedValue(status({ photoCount: 2500 }));
    const { container } = await mount();
    expect(flat(container.querySelector('.how-long'))).toMatch(/about [\d.]+ hours\b/);
  });
  it('a handful of photos is not dressed up as a wait', async () => {
    getSlideshow.mockResolvedValue(status({ photoCount: 4 }));
    const { container } = await mount();
    expect(flat(container.querySelector('.how-long'))).toContain('a minute or two');
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
    getSlideshow.mockResolvedValue(status());
    const { container } = await mount();
    const at4k = flat(container.querySelector('.how-long'));
    await fireEvent.change(screen.getByDisplayValue('4K'), { target: { value: '1080p' } });
    expect(flat(container.querySelector('.how-long'))).not.toBe(at4k);
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
