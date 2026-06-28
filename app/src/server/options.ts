// Single source of truth for the selectable options the UI renders. The frontend pulls
// these from /api/config and builds every dropdown from them, so option lists are never
// hard-coded (or duplicated) in the HTML/JS. Add/adjust choices here only.
const options = {
  durations: [
    { value: 1,   label: '1 hour'  },
    { value: 2,   label: '2 hours' },
    { value: 4,   label: '4 hours' },
    { value: 6,   label: '6 hours' },
    { value: 8,   label: '8 hours' },
    { value: 12,  label: '12 hours' },
    { value: 24,  label: '24 hours' },
    { value: 48,  label: '2 days' },
    { value: 72,  label: '3 days' },
    { value: 168, label: '1 week' },
  ],
  // Values aligned to the price tiers (12 free · 24 +$3 · 36 +$5 · 48 +$8) so each option is its own price.
  shotsPerPerson: [12, 24, 36, 48].map((n) => ({ value: n, label: String(n) })),
  revealModes: [
    { value: 'instant', label: 'Instant',    icon: '⚡', desc: 'Photos visible immediately to everyone with the link' },
    { value: 'at_end',  label: 'At the End', icon: '⏳', desc: 'Hidden until the event ends, then visible to all' },
    { value: 'manual',  label: 'Manual',     icon: '🔒', desc: 'You choose when to reveal to everyone' },
  ],
  revealDelays: [
    { value: 0,  label: 'Immediately at end' },
    { value: 1,  label: '1 hour after' },
    { value: 3,  label: '3 hours after' },
    { value: 12, label: '12 hours after' },
    { value: 24, label: '24 hours after' },
  ],
  // Capture aspect ratios. 1:1 is the free standard; the rest are flagged `pro` for
  // plan-gating once billing exists (not enforced yet). The event picks which to allow;
  // one = locked, several = the guest chooses on the camera.
  aspectRatios: [
    { value: 'full', label: 'Full',          pro: true  },
    { value: '9:16', label: 'Tall · 9:16',   pro: true  },
    { value: '4:5',  label: 'Portrait · 4:5', pro: true },
    { value: '3:4',  label: 'Classic · 3:4', pro: true  },
    { value: '1:1',  label: 'Square · 1:1',  pro: false },
  ],
  // Photo curation mode. 'favourite' = one-tap ★ (default). 'stars' = 1–5 rating
  // where 5★ is an instant favourite; share rules can then gate on "N★ or greater".
  ratingModes: [
    { value: 'favourite', label: 'Favourite (★)', desc: 'One tap to favourite' },
    { value: 'stars',     label: '1–5 Stars',     desc: 'Rate each photo; 5★ = favourite' },
  ],
  // Light/dark/system. Default is "system" (follows the device).
  themeModes: [
    { value: 'system', label: 'System' },
    { value: 'light',  label: 'Light'  },
    { value: 'dark',   label: 'Dark'   },
  ],
  // Web-safe font stacks only (no external fonts — CSP is same-origin). Applied app-wide via --font.
  fonts: [
    { value: 'system',   label: 'System',    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" },
    { value: 'serif',    label: 'Serif',     stack: "Georgia, 'Times New Roman', serif" },
    { value: 'mono',     label: 'Mono',      stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
    { value: 'rounded',  label: 'Rounded',   stack: "'Trebuchet MS', 'Segoe UI', system-ui, sans-serif" },
    { value: 'condensed',label: 'Condensed', stack: "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif" },
  ],
  defaults: { durationHours: 24, maxPhotos: 12, revealMode: 'at_end', aspectRatios: ['1:1'] },
};

export default options;
