import { describe, it, expect } from 'vitest';
import { isLight } from './theme';

describe('theme.isLight', () => {
  it('light mode is always light', () => {
    expect(isLight('light')).toBe(true);
  });
  it('dark mode is never light', () => {
    expect(isLight('dark')).toBe(false);
  });
});
