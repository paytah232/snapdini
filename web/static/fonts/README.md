# Bundled typefaces

Self-hosted so the poster designer renders identically offline and so canvas never silently
falls back to Arial mid-export. Latin subset, woff2, pulled from Google Fonts.

All five are licensed under the SIL Open Font License 1.1 — the shared licence text is in
`OFL.txt`; each family's own copyright notice is below. The OFL permits bundling and
redistribution with the application, which is what this directory is.

| File | Family | Role in the poster designer | Copyright |
| --- | --- | --- | --- |
| `playfair-display.woff2` | Playfair Display (variable 400–900) | Display serif — high-contrast headline caps | Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display" |
| `cormorant-garamond.woff2` | Cormorant Garamond (variable 300–700) | Formal serif — body copy and small caps | Copyright 2015 the Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) |
| `great-vibes.woff2` | Great Vibes | Formal copperplate script | Copyright 2015 The Great Vibes Pro Project Authors (https://github.com/googlefonts/great-vibes) |
| `sacramento.woff2` | Sacramento | Monoline modern script | Copyright (c) 2012, Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Names 'Sacramento' |
| `jost.woff2` | Jost (variable 100–900) | Geometric sans — wide-tracked instruction caps | Copyright 2020 The Jost Project Authors (https://github.com/indestructible-type) |

Reserved Font Names must not be used for a modified version — so if one of these is ever
re-subsetted or hinted differently, rename the family before shipping it.
