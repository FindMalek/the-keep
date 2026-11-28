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

/** The current query string; components read their filters from it so every view is linkable. */
export function useSearch(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return new URLSearchParams(search);
}

/** Opens an in-app URL (path and query). */
export function go(href: string): void {
  if (href === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

/** Click handler for in-app links; leaves cmd/ctrl-click to the browser. */
export function navigate(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  const href = event.currentTarget.getAttribute("href");
  if (href) go(href);
}

/** Replaces the current history entry; old bookmarks like `/system` land on their new page. */
export function redirect(to: string): void {
  window.history.replaceState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE));
}

/** Changes query params in place (no new history entry); null or "" removes one, an array repeats it. */
export function setQuery(patch: Record<string, string | number | null | undefined | string[]>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    url.searchParams.delete(key);
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  window.dispatchEvent(new Event(NAVIGATE));
}
