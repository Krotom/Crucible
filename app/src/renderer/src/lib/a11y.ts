// Accessibility switches: colours that stay apart for colour-blind eyes (blue and orange instead of blue and red) and larger text.
// Colours in CSS follow the `data-cb` attribute on <html>; the 3D view asks for `allianceHex`. Large text is a zoom factor on the whole window.
export interface A11y { colorblind: boolean; large: boolean }
export const NORMAL_HEX = { blue: 0x4cc2ff, red: 0xff5566 }
export const CB_HEX = { blue: 0x3b8fd6, red: 0xe69f00 } // a mid blue and the Okabe-Ito orange: different in hue and in lightness
export const LARGE_ZOOM = 1.2

let current: A11y = { colorblind: false, large: false }
export const getA11y = (): A11y => ({ ...current })
export function setA11y(a: A11y): void { current = { ...a } }
export function allianceHex(alliance: 'blue' | 'red'): number { return (current.colorblind ? CB_HEX : NORMAL_HEX)[alliance] }
export const zoomFor = (a: A11y): number => (a.large ? LARGE_ZOOM : 1)
