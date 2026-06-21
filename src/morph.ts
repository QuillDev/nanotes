import React from 'react';

// Shared "morph" animation — the surface that grows from a collapsed pill/sliver
// into a panel sized to its content, with the height driven explicitly so CSS can
// transition the grow/shrink smoothly (open/close and as content changes). Used
// by the search island (React) and the code-block language dropdown (imperative
// CodeMirror widget). The visuals live in styles.css: .morphSurface (the shell),
// .morphRow (per-row fade-in), .morphScroll (pink accent scrollbar).

// React side: measure the open height and feed it back as an inline style.
// Returns a ref to attach to the morphing element and the height to apply — left
// undefined while closed or before the first measurement so the element's CSS
// rest height shows through (e.g. the island's pill height).
export function useMorphHeight<T extends HTMLElement>(
  open: boolean,
  deps: React.DependencyList,
): { ref: React.RefObject<T | null>; height: number | undefined } {
  const ref = React.useRef<T | null>(null);
  const [height, setHeight] = React.useState(0);
  React.useLayoutEffect(() => {
    if (open) {
      setHeight(ref.current?.scrollHeight ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);
  return { ref, height: open && height > 0 ? height : undefined };
}

// Imperative side, for DOM built outside React. The panel must be a .morphSurface
// (overflow clipped, height transitioned) already mounted with its content.

// Grow the panel from 0 up to its content height. Measures first, then commits 0
// as the transition's start value before growing, so the grow actually animates.
export function morphOpen(panel: HTMLElement): void {
  const target = panel.scrollHeight;
  panel.style.height = '0px';
  void panel.offsetHeight; // force reflow so 0 is the transition baseline
  panel.style.height = `${target}px`;
}

// Re-fit the panel to its current content (e.g. after filtering a list), letting
// CSS animate the resize. Safe to call any time after morphOpen.
export function syncMorphHeight(panel: HTMLElement): void {
  panel.style.height = `${panel.scrollHeight}px`;
}

// Collapse the panel back to 0 and run onDone (e.g. remove it) once the height
// transition ends — with a timeout fallback in case transitionend never fires.
export function morphClose(panel: HTMLElement, onDone: () => void): void {
  panel.style.height = `${panel.scrollHeight}px`;
  void panel.offsetHeight;
  panel.style.height = '0px';
  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    panel.removeEventListener('transitionend', onEnd);
    onDone();
  };
  const onEnd = (event: TransitionEvent) => {
    if (event.target === panel && event.propertyName === 'height') {
      finish();
    }
  };
  panel.addEventListener('transitionend', onEnd);
  window.setTimeout(finish, 400);
}
