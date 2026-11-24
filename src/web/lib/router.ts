import { useSyncExternalStore, type MouseEvent } from "react";

const NAVIGATE = "keep:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useSearch(): string {
  return useSyncExternalStore(subscribe, () => window.location.search);
}

/** Click handler for in-app links; leaves cmd/ctrl-click to the browser. */
export function navigate(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  const href = event.currentTarget.getAttribute("href");
  if (!href || href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

/** Replaces the current history entry; old bookmarks like `/system` land on their new page. */
export function redirect(to: string): void {
  window.history.replaceState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE));
}
