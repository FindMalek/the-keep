const FLASH_MS = 1600;

/** Scrolls to a section, puts it in the URL hash and flashes its border so the eye lands on it. */
export function jumpTo(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  element.classList.remove("is-flash");
  // Restart the animation when the same tile is clicked twice.
  void element.offsetWidth;
  element.classList.add("is-flash");
  window.setTimeout(() => element.classList.remove("is-flash"), FLASH_MS);
}
