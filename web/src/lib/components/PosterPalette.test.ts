// The image swatch strip used to exist only INSIDE the poster's flat "Text colours" list, and that
// is the reason the list could not simply be deleted when its rows turned out to be a second copy
// of the swatches on the fields themselves. One component now, used from the two poster steps that
// own colours and from the cards tab — so it can be moved without being duplicated, and it can
// never end up on one screen twice.
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import PosterPalette from './PosterPalette.svelte';

const PALETTE = ['#112233', '#445566', '#778899'];

describe('the image swatch strip', () => {
  it('says which control the colours will land on', () => {
    // The whole point of the label: a swatch writes to ONE target, and a host who cannot see which
    // is about to be recoloured is guessing.
    const { getByText, getAllByRole } = render(PosterPalette, { palette: PALETTE, label: 'Footer URL', pick: () => {} });
    expect(getByText(/From your image → Footer URL/)).toBeTruthy();
    expect(getAllByRole('button')).toHaveLength(3);
  });

  it('hands the colour that was pressed to the caller', () => {
    // applySwatch() in the modal stays the single implementation of "what does a colour do" — this
    // only reports which one.
    const pick = vi.fn();
    const { getAllByRole } = render(PosterPalette, { palette: PALETTE, label: 'Title', pick });
    fireEvent.click(getAllByRole('button')[1]);
    expect(pick).toHaveBeenCalledWith('#445566');
  });

  it('draws nothing when there is nothing on screen to colour', () => {
    // The Join step with both the code and the footer URL switched off: no dot, so no target, so
    // swatches here would be a control with nowhere to write. A blank label is that state.
    const { queryAllByRole } = render(PosterPalette, { palette: PALETTE, label: '', pick: () => {} });
    expect(queryAllByRole('button')).toHaveLength(0);
  });

  it('draws nothing when the design has no image to pull colours out of', () => {
    const { queryAllByRole, queryByText } = render(PosterPalette, { palette: [], label: 'Title', pick: () => {} });
    expect(queryAllByRole('button')).toHaveLength(0);
    expect(queryByText(/From your image/)).toBeNull();
  });

  it('names every swatch by its colour, because a bare square says nothing', () => {
    const { getByLabelText } = render(PosterPalette, { palette: PALETTE, label: 'Title', pick: () => {} });
    expect(getByLabelText('Use #778899')).toBeTruthy();
  });
});
