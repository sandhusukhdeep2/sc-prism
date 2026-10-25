// Shared status glyphs — ONE source of truth so the ok-check and the FAIL mark
// never drift across surfaces. The fail mark had two variants in the app:
// U+2717 (✗ BALLOT X) and U+2715 (✕ MULTIPLICATION X); P11 standardises on
// U+2715. Import these (or `statusGlyph`) instead of hardcoding the character.
export const OK_GLYPH = '✓' // U+2713 CHECK MARK
export const FAIL_GLYPH = '✕' // U+2715 MULTIPLICATION X — the standard fail mark

/** The ok-check / fail mark for a boolean pass state. */
export const statusGlyph = (ok: boolean): string => (ok ? OK_GLYPH : FAIL_GLYPH)
