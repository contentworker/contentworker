// The slice of jsdom's API the node tests use (a second window on another origin, for the live
// preview two-window test). jsdom ships no types of its own.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis;
  }
}
