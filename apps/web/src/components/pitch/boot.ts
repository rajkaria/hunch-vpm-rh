/**
 * The deck's canvas and its fit rule, shared by the server page (which inlines `bootScript` so the
 * first paint is already scaled) and the client Deck (which re-applies the rule on resize). Kept
 * out of the 'use client' module so the server page receives the string itself.
 */

export const CANVAS = { width: 1920, height: 1080 } as const;

/** Below this width, on a portrait screen, the slides stack and the page scrolls. */
export const STACK_BELOW = 820;

export type DeckMode = 'deck' | 'stack';

export function fit(width: number, height: number): { mode: DeckMode; scale: number } {
  const stack = width < STACK_BELOW && height > width;
  return {
    mode: stack ? 'stack' : 'deck',
    scale: stack ? width / CANVAS.width : Math.min(width / CANVAS.width, height / CANVAS.height),
  };
}

/** `fit` as a self-contained script for the HTML head of the page: it runs before React hydrates. */
export const bootScript = `(function(){try{var w=innerWidth,h=innerHeight;if(!w||!h)return;var s=w<${STACK_BELOW}&&h>w,d=document.documentElement;d.dataset.deckMode=s?'stack':'deck';d.style.setProperty('--deck-scale',String(s?w/${CANVAS.width}:Math.min(w/${CANVAS.width},h/${CANVAS.height})));}catch(e){}})();`;
