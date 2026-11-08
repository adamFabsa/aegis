// Tracks which images have actually loaded, so the map never shows a broken image (Safari's "?")
// while the turned views are still being rendered or downloaded. Callers ask `ready(url)`; the
// first ask starts the download, and the map re-renders when it lands.
import { useSyncExternalStore } from 'react';

const loaded = new Set<string>();
const failed = new Set<string>();
const started = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function bump() {
  version++;
  for (const f of listeners) f();
}

export function ready(url: string): boolean {
  if (loaded.has(url)) return true;
  if (!started.has(url) && !failed.has(url)) {
    started.add(url);
    const im = new Image();
    im.onload = () => { loaded.add(url); bump(); };
    im.onerror = () => { failed.add(url); };
    im.src = url;
  }
  return false;
}

/** Re-render when any tracked image finishes loading. */
export function useAssetVersion(): number {
  return useSyncExternalStore(
    (f) => { listeners.add(f); return () => listeners.delete(f); },
    () => version,
  );
}
