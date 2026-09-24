/**
 * Full text on hover for anything the layout cut off with "…".
 *
 * One delegated listener for the whole app rather than a title attribute on
 * every truncating element: it covers places added later without anyone
 * remembering to, and it only adds a tooltip when text is genuinely cut - a
 * title that fits does not also pop up a copy of itself.
 */

const TRUNCATING = '.truncate, .clamp2, .clamp3';

function isCut(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

export function installOverflowTitles(): void {
  document.addEventListener(
    'mouseover',
    (event) => {
      const el = (event.target as Element | null)?.closest?.(TRUNCATING) as HTMLElement | null;
      if (!el) return;
      // A title set on purpose elsewhere always wins.
      if (el.hasAttribute('title') && !el.dataset.autoTitle) return;
      const text = el.textContent?.trim() ?? '';
      if (text && isCut(el)) {
        el.title = text;
        el.dataset.autoTitle = '1';
      } else if (el.dataset.autoTitle) {
        // It fits now (the window grew, the text changed) - drop the stale copy.
        el.removeAttribute('title');
        delete el.dataset.autoTitle;
      }
    },
    { passive: true }
  );
}
