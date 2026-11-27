import { useSyncExternalStore } from "react";

/** True while a media query matches, e.g. the phone layout. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

export const PHONE = "(max-width: 720px)";
