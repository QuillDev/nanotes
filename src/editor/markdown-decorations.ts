import { EditorState, StateField } from '@codemirror/state';
import type { Range, Transaction } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { IS_DESKTOP, assetUrl } from '../desktop/bridge';
import { expandHome, openLinkTarget, type HiddenRange } from '../desktop/config';

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'cm-list-bullet';
    bullet.textContent = '•';
    return bullet;
  }

  ignoreEvent() {
    return false;
  }
}

const bulletWidget = new BulletWidget();

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#].*)?$/i;
// `![alt](path)` (image) or a plain `[label](path)` link whose target is an image.
// The destination allows balanced parentheses (e.g. `image(1).png`) per CommonMark,
// matching either a `(…)` group or any non-paren char rather than stopping at the
// first `)`. One level of nesting is handled, which covers real-world filenames.
const IMAGE_LINK_RE =
  /(!)?\[[^\]]*\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

// Turns a Markdown link target into something the webview can load: http(s)/data
// URLs pass through, `~` expands to the home dir, and local paths go through the
// desktop app's asset:// protocol (file:// is blocked in the page).
async function resolveImageSrc(raw: string): Promise<string> {
  const path = raw.trim();
  if (/^(https?:|data:|blob:|asset:)/i.test(path)) {
    return path;
  }
  if (!IS_DESKTOP) {
    return path;
  }
  return assetUrl(await expandHome(path));
}

// Block widget that renders the referenced image on its own line, below the link.
class ImageWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src;
  }

  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-image-preview';
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => wrap.classList.add('cm-image-preview-error');
    void resolveImageSrc(this.src).then(url => {
      img.src = url;
    });
    // Cmd/Ctrl-clicking the preview opens the image in the system viewer, matching
    // the modifier-click behaviour on the link text itself.
    wrap.addEventListener('mousedown', event => {
      if (event.button === 0 && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        openLinkTarget(this.src);
      }
    });
    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

// Renders the `- [ ]` / `- [x]` marker of a task-list item as a clickable box.
// Clicking flips the status character in the document so the checked state lives
// in the file, not just the view.
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly statusPos: number) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.statusPos === this.statusPos;
  }

  toDOM(view: EditorView) {
    const box = document.createElement('span');
    box.className = this.checked ? 'cm-task-checkbox cm-task-checkbox-checked' : 'cm-task-checkbox';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    box.textContent = this.checked ? '✓' : '';
    box.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        changes: { from: this.statusPos, to: this.statusPos + 1, insert: this.checked ? ' ' : 'x' },
        userEvent: 'input.toggleTask',
      });
    });
    return box;
  }

  ignoreEvent() {
    return false;
  }
}

// indent, list marker, `[`, status char, `]`, trailing space.
const TASK_ITEM_RE = /^(\s*)([-*+])(\s+)\[([ xX])\](\s)/;

function taskMarkerRangeForLine(line: { from: number; text: string }): HiddenRange | null {
  const task = TASK_ITEM_RE.exec(line.text);
  if (!task) {
    return null;
  }
  const markerStart = line.from + task[1].length;
  const statusPos = markerStart + task[2].length + task[3].length + 1;
  return { from: markerStart, to: statusPos + 2 };
}

// A clickable link on a single line, with offsets relative to the line start.
// `textFrom`/`textTo` bound the visible (clickable) portion; for a bare URL that
// is the whole token, for `[text](url)` it is just the label between the
// brackets (the `[`, `](url)` syntax is hidden in the view).
interface LineLink {
  from: number;
  to: number;
  textFrom: number;
  textTo: number;
  url: string;
}

const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^()\s]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]]+/g;

function findLinksInLine(text: string): LineLink[] {
  const links: LineLink[] = [];
  const taken: Array<[number, number]> = [];
  const free = (from: number, to: number) => !taken.some(([start, end]) => from < end && to > start);

  // Markdown links first so the URL inside `(...)` isn't also matched as a bare URL.
  for (const match of text.matchAll(MD_LINK_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const from = match.index;
    const to = from + match[0].length;
    if (!free(from, to)) {
      continue;
    }
    const textFrom = from + 1;
    links.push({ from, to, textFrom, textTo: textFrom + match[1].length, url: match[2] });
    taken.push([from, to]);
  }

  for (const match of text.matchAll(BARE_URL_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const from = match.index;
    // Drop trailing sentence punctuation so "see https://x.com." excludes the period.
    const url = match[0].replace(/[.,;:!?'"\)\]]+$/, '');
    const to = from + url.length;
    if (to <= from || !free(from, to)) {
      continue;
    }
    links.push({ from, to, textFrom: from, textTo: to, url });
    taken.push([from, to]);
  }

  return links;
}

function linkAt(state: EditorState, position: number): string | null {
  const line = state.doc.lineAt(position);
  const offset = position - line.from;
  for (const link of findLinksInLine(line.text)) {
    if (offset >= link.textFrom && offset <= link.textTo) {
      return link.url;
    }
  }
  return null;
}

function addInlineMarkdownDecorations(lineStart: number, text: string, decorations: Array<Range<Decoration>>) {
  const occupied: Array<[number, number]> = [];

  const overlaps = (from: number, to: number) => occupied.some(([start, end]) => from < end && to > start);
  const remember = (from: number, to: number) => occupied.push([from, to]);

  const addMatch = (start: number, end: number, delimiterLength: number, className: string) => {
    const contentFrom = start + delimiterLength;
    const contentTo = end - delimiterLength;
    if (contentFrom >= contentTo || overlaps(start, end)) {
      return;
    }
    decorations.push(Decoration.replace({ class: 'cm-hidden-inline-marker' }).range(lineStart + start, lineStart + contentFrom));
    decorations.push(Decoration.mark({ class: className }).range(lineStart + contentFrom, lineStart + contentTo));
    decorations.push(Decoration.replace({ class: 'cm-hidden-inline-marker' }).range(lineStart + contentTo, lineStart + end));
    remember(start, end);
  };

  // Links are claimed first so emphasis markers inside a URL don't get hidden.
  for (const link of findLinksInLine(text)) {
    if (overlaps(link.from, link.to)) {
      continue;
    }
    if (link.textFrom > link.from) {
      decorations.push(Decoration.replace({ class: 'cm-hidden-inline-marker' }).range(lineStart + link.from, lineStart + link.textFrom));
    }
    decorations.push(Decoration.mark({ class: 'cm-link' }).range(lineStart + link.textFrom, lineStart + link.textTo));
    if (link.textTo < link.to) {
      decorations.push(Decoration.replace({ class: 'cm-hidden-inline-marker' }).range(lineStart + link.textTo, lineStart + link.to));
    }
    remember(link.from, link.to);
  }

  for (const match of text.matchAll(/(\*\*|__)(\S(?:.*?\S)?)\1/g)) {
    if (match.index === undefined) {
      continue;
    }
    addMatch(match.index, match.index + match[0].length, 2, 'cm-bold-text');
  }

  for (const match of text.matchAll(/(^|[^*_])(\*|_)(\S(?:.*?\S)?)\2(?![*_])/g)) {
    if (match.index === undefined) {
      continue;
    }
    const prefixLength = match[1].length;
    const start = match.index + prefixLength;
    addMatch(start, match.index + match[0].length, 1, 'cm-italic-text');
  }
}

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      const match = /^(#{1,6})\s/.exec(line.text);
      if (match) {
        const level = match[1].length;
        decorations.push(Decoration.replace({ class: 'cm-hidden-heading-marker' }).range(line.from, line.from + level + 1));
        if (line.from + level + 1 < line.to) {
          decorations.push(
            Decoration.mark({ class: `cm-heading-text cm-heading-${level}` }).range(line.from + level + 1, line.to),
          );
        }
      }
      const task = TASK_ITEM_RE.exec(line.text);
      if (task) {
        // Replace `- [ ]` (marker through the closing bracket) with the box,
        // leaving the trailing space and item text in place.
        const markerRange = taskMarkerRangeForLine(line)!;
        const statusPos = markerRange.to - 2;
        const checked = task[4].toLowerCase() === 'x';
        decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked, statusPos) }).range(markerRange.from, markerRange.to));
      } else {
        const bullet = /^(\s*)([-*+])(\s)/.exec(line.text);
        if (bullet) {
          const markerStart = line.from + bullet[1].length;
          decorations.push(Decoration.replace({ widget: bulletWidget }).range(markerStart, markerStart + 1));
        }
      }
      addInlineMarkdownDecorations(line.from, line.text, decorations);
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}

function hiddenRangesForLine(state: EditorState, lineNumber: number): HiddenRange[] {
  const line = state.doc.line(lineNumber);
  const ranges: HiddenRange[] = [];
  const occupied: Array<[number, number]> = [];
  const text = line.text;

  const addRange = (from: number, to: number) => {
    if (from < to) {
      ranges.push({ from: line.from + from, to: line.from + to });
    }
  };
  const overlaps = (from: number, to: number) => occupied.some(([start, end]) => from < end && to > start);
  const remember = (from: number, to: number) => occupied.push([from, to]);

  const heading = /^(#{1,6})\s/.exec(text);
  if (heading) {
    addRange(0, heading[1].length + 1);
  }

  const addInlineRange = (start: number, end: number, delimiterLength: number) => {
    const contentFrom = start + delimiterLength;
    const contentTo = end - delimiterLength;
    if (contentFrom >= contentTo || overlaps(start, end)) {
      return;
    }
    addRange(start, contentFrom);
    addRange(contentTo, end);
    remember(start, end);
  };

  for (const link of findLinksInLine(text)) {
    if (overlaps(link.from, link.to)) {
      continue;
    }
    if (link.textFrom > link.from) {
      addRange(link.from, link.textFrom);
    }
    if (link.textTo < link.to) {
      addRange(link.textTo, link.to);
    }
    remember(link.from, link.to);
  }

  for (const match of text.matchAll(/(\*\*|__)(\S(?:.*?\S)?)\1/g)) {
    if (match.index !== undefined) {
      addInlineRange(match.index, match.index + match[0].length, 2);
    }
  }

  for (const match of text.matchAll(/(^|[^*_])(\*|_)(\S(?:.*?\S)?)\2(?![*_])/g)) {
    if (match.index !== undefined) {
      const start = match.index + match[1].length;
      addInlineRange(start, match.index + match[0].length, 1);
    }
  }

  return ranges.sort((a, b) => a.from - b.from || a.to - b.to);
}

function hiddenRangesAtPosition(state: EditorState, position: number): HiddenRange[] {
  const line = state.doc.lineAt(Math.min(position, state.doc.length));
  return hiddenRangesForLine(state, line.number);
}

function taskMarkerRangeAtPosition(state: EditorState, position: number): HiddenRange | null {
  const line = state.doc.lineAt(Math.min(position, state.doc.length));
  return taskMarkerRangeForLine(line);
}

function visibleLineStart(state: EditorState, position: number): number {
  const line = state.doc.lineAt(position);
  const prefix = hiddenRangesForLine(state, line.number).find(range => range.from === line.from);
  return prefix?.to ?? line.from;
}

function visibleLineEnd(state: EditorState, position: number): number {
  const line = state.doc.lineAt(position);
  const suffix = [...hiddenRangesForLine(state, line.number)].reverse().find(range => range.to === line.to);
  return suffix?.from ?? line.to;
}

function skipHiddenLeft(state: EditorState, position: number): number {
  if (position <= 0) {
    return position;
  }
  const taskMarker = taskMarkerRangeAtPosition(state, position);
  if (taskMarker && position > taskMarker.from && position <= taskMarker.to) {
    return taskMarker.from;
  }
  let target = position - 1;
  const line = state.doc.lineAt(position);
  for (const range of hiddenRangesAtPosition(state, position)) {
    if (target >= range.from && target < range.to) {
      target = range.from === line.from ? range.to : range.from;
      break;
    }
  }
  return target;
}

function skipHiddenRight(state: EditorState, position: number): number {
  if (position >= state.doc.length) {
    return position;
  }
  const taskMarker = taskMarkerRangeAtPosition(state, position);
  if (taskMarker && position >= taskMarker.from && position < taskMarker.to) {
    return taskMarker.to;
  }
  let target = position + 1;
  for (const range of hiddenRangesAtPosition(state, position)) {
    if (target > range.from && target <= range.to) {
      target = range.to;
      break;
    }
  }
  return target;
}

interface LineRangeCache {
  hidden: Map<number, HiddenRange[]>;
  task: Map<number, HiddenRange | null>;
}

function createLineRangeCache(): LineRangeCache {
  return { hidden: new Map(), task: new Map() };
}

function cachedHiddenRangesAtPosition(
  state: EditorState,
  position: number,
  cache: LineRangeCache,
): HiddenRange[] {
  const line = state.doc.lineAt(Math.min(position, state.doc.length));
  let ranges = cache.hidden.get(line.number);
  if (!ranges) {
    ranges = hiddenRangesForLine(state, line.number);
    cache.hidden.set(line.number, ranges);
  }
  return ranges;
}

function cachedTaskMarkerRangeAtPosition(
  state: EditorState,
  position: number,
  cache: LineRangeCache,
): HiddenRange | null {
  const line = state.doc.lineAt(Math.min(position, state.doc.length));
  if (cache.task.has(line.number)) {
    return cache.task.get(line.number) ?? null;
  }
  const range = taskMarkerRangeForLine(line);
  cache.task.set(line.number, range);
  return range;
}

function isVisibleWordChar(state: EditorState, position: number, cache: LineRangeCache): boolean {
  if (position < 0 || position >= state.doc.length) {
    return false;
  }
  const taskMarker = cachedTaskMarkerRangeAtPosition(state, position, cache);
  if (taskMarker && position >= taskMarker.from && position < taskMarker.to) {
    return false;
  }
  if (cachedHiddenRangesAtPosition(state, position, cache).some(range => position >= range.from && position < range.to)) {
    return false;
  }
  return /[\p{L}\p{N}_]/u.test(state.sliceDoc(position, position + 1));
}

function previousVisibleChar(state: EditorState, before: number, cache: LineRangeCache): number | undefined {
  for (let position = Math.min(before - 1, state.doc.length - 1); position >= 0; position -= 1) {
    const taskMarker = cachedTaskMarkerRangeAtPosition(state, position, cache);
    if (taskMarker && position >= taskMarker.from && position < taskMarker.to) {
      return taskMarker.from;
    }
    if (!cachedHiddenRangesAtPosition(state, position, cache).some(range => position >= range.from && position < range.to)) {
      return position;
    }
  }
  return undefined;
}

function nextVisibleChar(state: EditorState, from: number, cache: LineRangeCache): number | undefined {
  for (let position = Math.max(from, 0); position < state.doc.length; position += 1) {
    const taskMarker = cachedTaskMarkerRangeAtPosition(state, position, cache);
    if (taskMarker && position >= taskMarker.from && position < taskMarker.to) {
      if (position === taskMarker.from) {
        return taskMarker.from;
      }
      position = taskMarker.to - 1;
      continue;
    }
    if (!cachedHiddenRangesAtPosition(state, position, cache).some(range => position >= range.from && position < range.to)) {
      return position;
    }
  }
  return undefined;
}

function visibleWordBoundary(state: EditorState, position: number, direction: 'left' | 'right'): number | undefined {
  const cache = createLineRangeCache();
  if (direction === 'left') {
    let char = previousVisibleChar(state, position, cache);
    while (char !== undefined && !isVisibleWordChar(state, char, cache)) {
      char = previousVisibleChar(state, char, cache);
    }
    if (char === undefined) {
      return undefined;
    }
    let start = char;
    let prev = previousVisibleChar(state, start, cache);
    while (prev !== undefined && isVisibleWordChar(state, prev, cache)) {
      start = prev;
      prev = previousVisibleChar(state, start, cache);
    }
    return start;
  }

  let char = nextVisibleChar(state, position, cache);
  while (char !== undefined && !isVisibleWordChar(state, char, cache)) {
    char = nextVisibleChar(state, char + 1, cache);
  }
  if (char === undefined) {
    return undefined;
  }
  let end = char + 1;
  let next = nextVisibleChar(state, end, cache);
  while (next !== undefined && isVisibleWordChar(state, next, cache)) {
    end = next + 1;
    next = nextVisibleChar(state, end, cache);
  }
  return end;
}

function moveByVisibleWord(view: EditorView, direction: 'left' | 'right', extend = false): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty && !extend) {
    return false;
  }
  const target = visibleWordBoundary(view.state, selection.head, direction);
  if (target === undefined) {
    return false;
  }
  view.dispatch({
    selection: extend ? { anchor: selection.anchor, head: target } : { anchor: target },
    scrollIntoView: true,
  });
  return true;
}

function deleteTaskMarkerBackward(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) {
    return false;
  }
  const taskMarker = taskMarkerRangeAtPosition(view.state, selection.head);
  if (!taskMarker || selection.head <= taskMarker.from || selection.head > taskMarker.to) {
    return false;
  }
  view.dispatch({
    changes: { from: taskMarker.from, to: taskMarker.to },
    selection: { anchor: taskMarker.from },
    scrollIntoView: true,
    userEvent: 'delete.backward',
  });
  return true;
}

function deleteTaskMarkerForward(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) {
    return false;
  }
  const taskMarker = taskMarkerRangeAtPosition(view.state, selection.head);
  if (!taskMarker || selection.head < taskMarker.from || selection.head >= taskMarker.to) {
    return false;
  }
  view.dispatch({
    changes: { from: taskMarker.from, to: taskMarker.to },
    selection: { anchor: taskMarker.from },
    scrollIntoView: true,
    userEvent: 'delete.forward',
  });
  return true;
}

// Cmd/Ctrl-click follows a link and opens it externally. A plain click still
// lands the cursor normally so URLs stay editable.
export const linkClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) {
      return false;
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) {
      return false;
    }
    const url = linkAt(view.state, pos);
    if (!url) {
      return false;
    }
    event.preventDefault();
    openLinkTarget(url);
    return true;
  },
});

// Toggles a `cm-mod-held` class on the editor whenever Cmd/Ctrl is down, so CSS
// can show a pointer cursor over links — signalling that a modifier-click opens
// them. Window-level listeners catch the modifier even when a key repeats or the
// window loses focus mid-press.
export const modifierKeyClass = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      window.addEventListener('keydown', this.sync, true);
      window.addEventListener('keyup', this.sync, true);
      window.addEventListener('blur', this.clear, true);
    }

    sync = (event: KeyboardEvent) => {
      this.view.dom.classList.toggle('cm-mod-held', event.metaKey || event.ctrlKey);
    };

    clear = () => {
      this.view.dom.classList.remove('cm-mod-held');
    };

    destroy() {
      window.removeEventListener('keydown', this.sync, true);
      window.removeEventListener('keyup', this.sync, true);
      window.removeEventListener('blur', this.clear, true);
      this.clear();
    }
  },
);

export const skipHiddenMarkdownKeymap = keymap.of([
  {
    key: 'Backspace',
    run: deleteTaskMarkerBackward,
  },
  {
    key: 'Delete',
    run: deleteTaskMarkerForward,
  },
  {
    key: 'ArrowLeft',
    run: view => {
      const selection = view.state.selection.main;
      if (!selection.empty) {
        return false;
      }
      view.dispatch({ selection: { anchor: skipHiddenLeft(view.state, selection.head) }, scrollIntoView: true });
      return true;
    },
  },
  {
    key: 'ArrowRight',
    run: view => {
      const selection = view.state.selection.main;
      if (!selection.empty) {
        return false;
      }
      view.dispatch({ selection: { anchor: skipHiddenRight(view.state, selection.head) }, scrollIntoView: true });
      return true;
    },
  },
  {
    key: 'Mod-ArrowLeft',
    run: view => {
      view.dispatch({ selection: { anchor: visibleLineStart(view.state, view.state.selection.main.head) }, scrollIntoView: true });
      return true;
    },
  },
  {
    key: 'Mod-ArrowRight',
    run: view => {
      view.dispatch({ selection: { anchor: visibleLineEnd(view.state, view.state.selection.main.head) }, scrollIntoView: true });
      return true;
    },
  },
  {
    key: 'Alt-ArrowLeft',
    run: view => moveByVisibleWord(view, 'left'),
    shift: view => moveByVisibleWord(view, 'left', true),
    preventDefault: true,
  },
  {
    key: 'Alt-ArrowRight',
    run: view => moveByVisibleWord(view, 'right'),
    shift: view => moveByVisibleWord(view, 'right', true),
    preventDefault: true,
  },
]);

// Typing a space right after `[]` or `- []` at the start of a line expands the
// shorthand into a canonical `- [ ] ` task item (which then renders as a box).
export const checkboxAutoFormat = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) {
    return false;
  }
  const { state } = view;
  const line = state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  const match = /^(\s*)(?:[-*+]\s+)?\[\]$/.exec(before);
  if (!match) {
    return false;
  }
  const insert = `${match[1]}- [ ] `;
  view.dispatch({
    changes: { from: line.from, to: from, insert },
    selection: { anchor: line.from + insert.length },
    userEvent: 'input.complete',
  });
  return true;
});

// Block-level image previews live in a StateField (not the ViewPlugin below):
// CodeMirror rejects block decorations supplied by a plugin, so they must be
// provided through the editor state.
function addImagePreviewDecorationsForLine(
  line: { text: string; to: number },
  decorations: Array<Range<Decoration>>,
) {
  // Fast reject lines that cannot contain a markdown link/image target.
  if (!line.text.includes('](')) {
    return;
  }
  // `![..](..)` always previews; a plain `[..](..)` link previews only when the
  // target looks like an image file, so a normal text link stays text.
  for (const match of line.text.matchAll(IMAGE_LINK_RE)) {
    const isImageSyntax = match[1] === '!';
    const target = match[2];
    if (isImageSyntax || IMAGE_EXT_RE.test(target)) {
      decorations.push(
        Decoration.widget({ widget: new ImageWidget(target), block: true, side: 1 }).range(line.to),
      );
    }
  }
}

function buildImagePreviewDecorations(state: EditorState): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    addImagePreviewDecorationsForLine(state.doc.line(lineNumber), decorations);
  }
  return Decoration.set(decorations, true);
}

function updateImagePreviewDecorations(prev: DecorationSet, transaction: Transaction): DecorationSet {
  const doc = transaction.state.doc;
  const changedLineRanges: Array<[number, number]> = [];
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const startLine = doc.lineAt(fromB).number;
    const endLine = doc.lineAt(toB).number;
    const last = changedLineRanges[changedLineRanges.length - 1];
    if (last && startLine <= last[1] + 1) {
      last[1] = Math.max(last[1], endLine);
    } else {
      changedLineRanges.push([startLine, endLine]);
    }
  });
  let next = prev.map(transaction.changes);
  for (const [startLine, endLine] of changedLineRanges) {
    const filterFrom = doc.line(startLine).from;
    const filterTo = doc.line(endLine).to;
    const add: Array<Range<Decoration>> = [];
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      addImagePreviewDecorationsForLine(doc.line(lineNumber), add);
    }
    next = next.update({
      filterFrom,
      filterTo,
      filter: () => false,
      add,
      sort: true,
    });
  }
  return next;
}

export const imagePreviewDecorations = StateField.define<DecorationSet>({
  create: state => buildImagePreviewDecorations(state),
  update(value, transaction) {
    if (transaction.docChanged) {
      return updateImagePreviewDecorations(value, transaction);
    }
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

export const headingLineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildHeadingDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildHeadingDecorations(update.view);
      }
    }
  },
  {
    decorations: plugin => plugin.decorations,
  },
);
