/**
 * The site's one bundled script, on every page: it slides a phone's sections strip to the current
 * page, and runs the reveals.
 *
 * Reveals: an element that carries `data-reveal` comes up once, as the reader scrolls near it
 * (opacity and 16px of rise, 60ms apart within one parent; the motion itself is in global.css).
 *
 * Two moments ride on the same reveal, each on its own parts (the elements inside it marked
 * `data-part`): an order's time card that carries `data-print` has its lines ink in, 60ms apart,
 * as its first line comes up (/orders/[id]); a chart that carries `data-rise` has its columns rise
 * from the baseline, 8ms apart (the Jobs Report's Chart 1).
 *
 * An unscrolled page is always complete. Nothing is hidden until this script has its observer
 * attached and the reader has scrolled once; at that moment everything already on screen or above
 * it is shown for good, and only what is still below waits for its turn. Without scripts, with
 * reduced motion, or on a page with nothing marked (the judges page, the questions page), no
 * observer is made and nothing is hidden. If this script stalls after arming, a finite CSS
 * failsafe shows everything.
 */

const STAGGER_MS = 60;
/** The gap between the parts of a moment: a card's lines, a chart's columns. */
const PART_STAGGER_MS: Record<string, number> = { print: 60, rise: 8 };

/**
 * On a phone the sections line is a strip that slides sideways. When the current page's link is
 * out of the strip's view, the strip is slid (never the page) so that the link and its mark show.
 */
function showCurrentSection(): void {
  const nav = document.querySelector<HTMLElement>(".nav");
  const link = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
  if (!nav || !link || nav.scrollWidth <= nav.clientWidth + 1) return;
  const strip = nav.getBoundingClientRect();
  const box = link.getBoundingClientRect();
  if (box.left >= strip.left && box.right <= strip.right) return;
  nav.scrollLeft += box.left - strip.left - (strip.width - box.width) / 2;
}

function reveal(elements: HTMLElement[]): void {
  // Within one parent the items come up one after another, in the order they are in the page.
  const byParent = new Map<Element | null, HTMLElement[]>();
  for (const element of elements) {
    // A moment's parts come in one after another inside it, in the order they are in the page.
    const moment = element.hasAttribute("data-print") ? "print" : element.hasAttribute("data-rise") ? "rise" : null;
    if (moment) {
      const gap = PART_STAGGER_MS[moment] ?? STAGGER_MS;
      element.querySelectorAll<HTMLElement | SVGElement>("[data-part]").forEach((part, index) => {
        part.style.setProperty("--part-delay", `${index * gap}ms`);
      });
      element.classList.add("is-revealed");
      continue;
    }
    const siblings = byParent.get(element.parentElement) ?? [];
    siblings.push(element);
    byParent.set(element.parentElement, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.forEach((element, index) => {
      element.style.setProperty("--reveal-delay", `${index * STAGGER_MS}ms`);
      element.classList.add("is-revealed");
    });
  }
}

function start(): void {
  const root = document.documentElement;
  const items = [...document.querySelectorAll<HTMLElement>("[data-reveal], [data-print], [data-rise]")];
  if (items.length === 0) return;
  if (!("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // Where an item is measured from: an order's card from its first line, so a card whose caption
  // shows and whose lines do not is still printed as its lines come up; anything else from itself.
  const anchorOf = (element: HTMLElement): Element =>
    (element.hasAttribute("data-print") && element.querySelector("[data-part]")) || element;
  const anchors = new Map(items.map((element) => [anchorOf(element), element] as const));
  const top = (element: HTMLElement) => anchorOf(element).getBoundingClientRect().top;

  // The items still to come up, in page order.
  const waiting = new Set(items);
  const done = (elements: HTMLElement[]) => {
    for (const element of elements) {
      waiting.delete(element);
      observer.unobserve(anchorOf(element));
    }
    if (waiting.size === 0) {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
    }
  };
  const inPageOrder = (elements: HTMLElement[]) => items.filter((element) => elements.includes(element));

  // An item comes up once its top edge is a little way (6%) up from the foot of the screen.
  const observer = new IntersectionObserver(
    (entries) => {
      if (!root.classList.contains("reveals-on")) return;
      const near = inPageOrder(
        entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => anchors.get(entry.target))
          .filter((element): element is HTMLElement => element !== undefined && waiting.has(element)),
      );
      if (near.length === 0) return;
      done(near);
      reveal(near);
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0 },
  );
  for (const anchor of anchors.keys()) observer.observe(anchor);

  // A long jump (the End key, a link to a fragment) can carry an item from below the screen to above
  // it between two frames, and the observer never sees it on screen. After each scroll, anything
  // still waiting that is now above that line comes up too.
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const line = window.innerHeight * 0.94;
      const passed = [...waiting].filter((element) => top(element) < line);
      if (passed.length === 0) return;
      done(passed);
      reveal(passed);
    });
  };

  const arm = () => {
    // What the reader has already seen, or is looking at now, is shown at once and never hidden.
    const fold = window.innerHeight;
    const seen = [...waiting].filter((element) => top(element) < fold);
    for (const element of seen) element.classList.add("is-revealed");
    done(seen);
    if (waiting.size === 0) return;
    root.classList.add("reveals-on");
    window.addEventListener("scroll", onScroll, { passive: true });
  };
  window.addEventListener("scroll", arm, { once: true, passive: true });
}

showCurrentSection();
start();
