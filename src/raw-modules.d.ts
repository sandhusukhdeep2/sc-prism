// Ambient type for Vite's `?raw` imports (file loaded as a string). Used by the
// LF-3 page-wiring pin (src/pages/lf3Wiring.test.ts) to read a page's source at
// test time without pulling in @types/node.
declare module '*?raw' {
  const content: string
  export default content
}

// Minimal ambient shim for the one Node built-in used by test-time file reads
// (the theme-token legibility guard reads real .css text — Vite's `?raw` returns
// empty for .css, so it uses fs). Avoids adding @types/node as a dependency.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readdirSync(path: string): string[]
  export function statSync(path: string): { isDirectory(): boolean }
}

// Same discipline for the one path helper the source-tree sweep needs (the
// Automations honesty test walks src/ to prove the loop simulator is gone).
declare module 'node:path' {
  export function join(...parts: string[]): string
}
