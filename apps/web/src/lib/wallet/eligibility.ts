/**
 * The one-time eligibility statement before the first bet (docs/spec/05 §Geo and eligibility),
 * remembered in this browser. Storage can be unavailable (private windows, blocked site data), so
 * every access is wrapped and the checkbox simply shows again.
 */

const KEY = 'hunch-rh.eligible.v1';

export function readEligible(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function writeEligible(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Not remembered; asked again next time.
  }
}
