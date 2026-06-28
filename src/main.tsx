import React from 'react';
import { createRoot } from 'react-dom/client';
import CodeMirror from '@uiw/react-codemirror';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { HighlightStyle, LanguageDescription, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { Prec, StateField } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, drawSelection, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { acceptCompletion, autocompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import { morphClose, morphOpen, syncMorphHeight, useMorphHeight } from './morph';
import './styles.css';

interface NoteState {
  notesDir: string;
  notePath: string;
  content: string;
  savedContent: string;
  status: 'idle' | 'loading' | 'saving' | 'saved' | 'error';
  message: string;
}

interface NoteEntry {
  path: string;
  title: string;
  modifiedMs: number;
}

interface NoteSaveResult {
  path: string;
  title: string;
}

interface HiddenRange {
  from: number;
  to: number;
}

const DEFAULT_NOTES_DIR = '~/.nanotes';
const DEFAULT_NOTE = 'Untitled.md';
const SAVE_DELAY_MS = 500;
const PINNED_KEY = 'nanotes:pinnedPaths';
const HOTKEY_KEY = 'nanotes:hotkey';
const IS_LINUX = /Linux/i.test(navigator.userAgent);
// Matches the Rust DEFAULT_HOTKEY: Option/Alt + N. Stored in the plugin's
// accelerator format ("alt+KeyN") so it round-trips straight to `set_hotkey`.
const DEFAULT_HOTKEY = 'alt+KeyN';
const HOTKEY_MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);
const HOTKEY_SYMBOLS: Record<string, string> = {
  super: '⌘',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
};

// Display name for the note currently in the editor: the first line with any
// leading "#" markers stripped, mirroring the backend's title_from_content so
// the topbar label matches what search shows. Falls back to "Untitled".
function titleFromContent(content: string): string {
  const firstLine = content.split('\n', 1)[0]?.trim() ?? '';
  const withoutHeading = firstLine.replace(/^#+/, '').trim();
  return withoutHeading || 'Untitled';
}

// Render an accelerator like "alt+KeyN" as platform-native UI text: "Alt+N" on
// Linux and compact macOS glyphs like "⌥N" elsewhere.
function formatHotkey(accelerator: string): string {
  const parts = accelerator
    .split('+')
    .map(part => {
      const normalized = part.toLowerCase();
      if (IS_LINUX) {
        const linuxLabels: Record<string, string> = {
          super: 'Super',
          cmd: 'Super',
          command: 'Super',
          meta: 'Super',
          commandorcontrol: 'Ctrl',
          cmdorctrl: 'Ctrl',
          control: 'Ctrl',
          ctrl: 'Ctrl',
          alt: 'Alt',
          option: 'Alt',
          shift: 'Shift',
        };
        const linuxLabel = linuxLabels[normalized];
        if (linuxLabel) {
          return linuxLabel;
        }
      }
      const symbol = HOTKEY_SYMBOLS[normalized];
      if (symbol) {
        return symbol;
      }
      const keyMatch = /^Key([A-Z])$/.exec(part);
      if (keyMatch) {
        return keyMatch[1];
      }
      const digitMatch = /^Digit([0-9])$/.exec(part);
      if (digitMatch) {
        return digitMatch[1];
      }
      return part;
    });
  return parts.join(IS_LINUX ? '+' : '');
}
function appShortcutLabel(key: string): string {
  return `${IS_LINUX ? 'Alt+' : '⌘'}${key}`;
}
const FRAME_KEY = 'nanotes:windowFrame';
const FRAME_SHAPE_KEY = 'nanotes:windowFrameShape';
// Bumped to v2 to discard frames saved by the buggy build that opened the window
// at half size (below the drag minimum) on HiDPI displays.
const CURRENT_FRAME_SHAPE = 'portrait-notepad-v2';
const SAMPLE_NOTE = `# NaNotes

Quick Markdown notes that stay in local files.

- Press \`${formatHotkey(DEFAULT_HOTKEY)}\` to toggle the overlay
- Type Markdown in one pane
- Markdown is styled while you edit

> Browser preview mode uses sample content. The desktop app reads and writes the configured notes folder.`;
const IS_TAURI = '__TAURI_INTERNALS__' in window;

function storedNotePath() {
  const stored = window.localStorage.getItem('nanotes:notePath');
  if (!stored || stored.includes('/')) {
    return DEFAULT_NOTE;
  }
  return stored;
}

// Common fence languages are preloaded with their support already resolved so
// `markdown()` never has to lazily import them — lazy loading leaves the first
// block uncoloured until the next edit. Rarer languages still come from the
// async `languages` list, which loads on demand.
const preloadedCodeLanguages = [
  LanguageDescription.of({ name: 'TypeScript', alias: ['ts'], extensions: ['ts', 'mts', 'cts'], support: javascript({ typescript: true }) }),
  LanguageDescription.of({ name: 'TSX', alias: ['tsx'], extensions: ['tsx'], support: javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: 'JavaScript', alias: ['js', 'node'], extensions: ['js', 'mjs', 'cjs'], support: javascript() }),
  LanguageDescription.of({ name: 'JSX', alias: ['jsx'], extensions: ['jsx'], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'JSON', alias: ['json'], extensions: ['json'], support: json() }),
  LanguageDescription.of({ name: 'Python', alias: ['python', 'py'], extensions: ['py'], support: python() }),
  LanguageDescription.of({ name: 'Rust', alias: ['rust', 'rs'], extensions: ['rs'], support: rust() }),
  LanguageDescription.of({ name: 'HTML', alias: ['html', 'htm'], extensions: ['html', 'htm'], support: html() }),
  LanguageDescription.of({ name: 'CSS', alias: ['css'], extensions: ['css'], support: css() }),
];

const codeLanguages = [...preloadedCodeLanguages, ...languages];

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: '#e8e9ee' },
  { tag: tags.heading2, color: '#e8e9ee' },
  { tag: tags.heading3, color: '#e8e9ee' },
  { tag: tags.heading4, color: '#e8e9ee' },
  { tag: tags.heading5, color: '#e8e9ee' },
  { tag: tags.heading6, color: '#e8e9ee' },
  { tag: tags.processingInstruction, color: '#8b90a0' },
  { tag: tags.strong, color: '#ffffff', fontWeight: '750' },
  { tag: tags.emphasis, color: '#e8e9ee', fontStyle: 'italic' },
  { tag: tags.link, color: '#ff7aa5', textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: tags.url, color: '#ff7aa5' },
  { tag: tags.monospace, color: '#f4a7bd' },
  { tag: tags.quote, color: '#8b90a0', fontStyle: 'italic' },
  { tag: tags.list, color: '#e8e9ee' },

  // Embedded code-fence languages (```ts, ```python, …).
  { tag: tags.keyword, color: '#c792ea' },
  { tag: [tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: '#c792ea' },
  { tag: [tags.string, tags.special(tags.string)], color: '#c3e88d' },
  { tag: [tags.number, tags.bool, tags.atom], color: '#f78c6c' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#5f6675', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#82aaff' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#82aaff' },
  { tag: [tags.definition(tags.variableName), tags.propertyName], color: '#e8e9ee' },
  { tag: [tags.variableName, tags.labelName], color: '#e8e9ee' },
  { tag: [tags.operator, tags.derefOperator, tags.punctuation, tags.separator, tags.bracket], color: '#8b90a0' },
  { tag: [tags.regexp, tags.escape], color: '#f4a7bd' },
  { tag: tags.meta, color: '#8b90a0' },
  { tag: tags.invalid, color: '#ff5874' },
]);

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: '#0a0a0d',
    color: '#e8e9ee',
    fontSize: '15px',
  },
  '.cm-scroller': {
    fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.75',
    padding: '28px 34px',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: '#ff7aa5',
    padding: '0',
    minHeight: '100%',
  },
  '.cm-line': {
    backgroundColor: 'transparent',
    padding: '0 0 0.18rem 0',
  },
  '.cm-cursor': {
    borderLeftColor: '#ff7aa5',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(246, 92, 142, 0.28)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },

  '.cm-placeholder': {
    color: '#555b6b',
  },
});

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

let homeDirCache: string | null = null;

// Expands a leading `~` to the absolute home directory (Tauri only).
async function expandHome(path: string): Promise<string> {
  if (!path.startsWith('~')) {
    return path;
  }
  if (!homeDirCache) {
    homeDirCache = (await homeDir()).replace(/\/+$/, '');
  }
  return homeDirCache + path.slice(1);
}

// Turns a Markdown link target into something the webview can load: http(s)/data
// URLs pass through, `~` expands to the home dir, and local paths go through the
// Tauri asset protocol (file:// is blocked in the webview).
async function resolveImageSrc(raw: string): Promise<string> {
  const path = raw.trim();
  if (/^(https?:|data:|blob:|asset:|tauri:)/i.test(path)) {
    return path;
  }
  if (!IS_TAURI) {
    return path;
  }
  return convertFileSrc(await expandHome(path));
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
    const url = match[0].replace(/[.,;:!?'")\]]+$/, '');
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

function openExternalUrl(url: string) {
  if (IS_TAURI) {
    void openUrl(url).catch(() => undefined);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// Opens a Markdown link/image target with whatever the OS associates it with:
// web URLs go to the browser; a local file path (e.g. an image) opens in the
// system default app for that type — the image viewer for a `.png`, etc.
function openLinkTarget(target: string) {
  const trimmed = target.trim();
  if (/^(https?:|mailto:|data:|blob:|asset:|tauri:)/i.test(trimmed)) {
    openExternalUrl(trimmed);
    return;
  }
  if (!IS_TAURI) {
    window.open(trimmed, '_blank', 'noopener,noreferrer');
    return;
  }
  void expandHome(trimmed)
    .then(path => openPath(path))
    .catch(() => undefined);
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
        const markerStart = line.from + task[1].length;
        const statusPos = markerStart + task[2].length + task[3].length + 1;
        const bracketEnd = statusPos + 2; // status char + `]`
        const checked = task[4].toLowerCase() === 'x';
        decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked, statusPos) }).range(markerStart, bracketEnd));
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
  let target = position + 1;
  for (const range of hiddenRangesAtPosition(state, position)) {
    if (target > range.from && target <= range.to) {
      target = range.to;
      break;
    }
  }
  return target;
}

function isVisibleWordChar(state: EditorState, position: number): boolean {
  if (position < 0 || position >= state.doc.length) {
    return false;
  }
  if (hiddenRangesAtPosition(state, position).some(range => position >= range.from && position < range.to)) {
    return false;
  }
  return /[\p{L}\p{N}_]/u.test(state.sliceDoc(position, position + 1));
}

function previousVisibleChar(state: EditorState, before: number): number | undefined {
  for (let position = Math.min(before - 1, state.doc.length - 1); position >= 0; position -= 1) {
    if (!hiddenRangesAtPosition(state, position).some(range => position >= range.from && position < range.to)) {
      return position;
    }
  }
  return undefined;
}

function nextVisibleChar(state: EditorState, from: number): number | undefined {
  for (let position = Math.max(from, 0); position < state.doc.length; position += 1) {
    if (!hiddenRangesAtPosition(state, position).some(range => position >= range.from && position < range.to)) {
      return position;
    }
  }
  return undefined;
}

function visibleWordBoundary(state: EditorState, position: number, direction: 'left' | 'right'): number | undefined {
  if (direction === 'left') {
    let char = previousVisibleChar(state, position);
    while (char !== undefined && !isVisibleWordChar(state, char)) {
      char = previousVisibleChar(state, char);
    }
    if (char === undefined) {
      return undefined;
    }
    let start = char;
    let prev = previousVisibleChar(state, start);
    while (prev !== undefined && isVisibleWordChar(state, prev)) {
      start = prev;
      prev = previousVisibleChar(state, start);
    }
    return start;
  }

  let char = nextVisibleChar(state, position);
  while (char !== undefined && !isVisibleWordChar(state, char)) {
    char = nextVisibleChar(state, char + 1);
  }
  if (char === undefined) {
    return undefined;
  }
  let end = char + 1;
  let next = nextVisibleChar(state, end);
  while (next !== undefined && isVisibleWordChar(state, next)) {
    end = next + 1;
    next = nextVisibleChar(state, end);
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

// Lezer-markdown only runs the embedded language parser over a fenced block
// once it is *terminated* — an unterminated fence whose code sits on the final
// document line never gets syntax-highlighted. So when Enter is pressed right
// after an opening fence, auto-insert the closing fence and drop the cursor on
// the (now highlightable) line between them.
function autoCloseFence(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty || selection.head !== state.doc.lineAt(selection.head).to) {
    return false;
  }
  const line = state.doc.lineAt(selection.head);
  const match = /^(\s*)(`{3,}|~{3,})([^`~]*)$/.exec(line.text);
  if (!match) {
    return false;
  }
  // Only act on the opening fence of the block, never a closing one.
  let node = syntaxTree(state).resolveInner(selection.head, -1);
  while (node && node.name !== 'FencedCode') {
    node = node.parent as typeof node;
  }
  if (!node || state.doc.lineAt(node.from).number !== line.number) {
    return false;
  }
  const [, indent, fence] = match;
  const closeRe = new RegExp(`^\\s*\\${fence[0]}{${fence.length},}\\s*$`);
  for (let lineNumber = line.number + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    if (closeRe.test(state.doc.line(lineNumber).text)) {
      return false; // block is already closed below
    }
  }
  view.dispatch({
    changes: { from: selection.head, insert: `\n${indent}\n${indent}${fence}` },
    selection: { anchor: selection.head + 1 + indent.length },
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  return true;
}

// Backspace at a fence boundary dissolves the whole block back to plain text
// (keeping the content), so a freshly-created block can be undone in one key:
//   1. cursor at the start of the first content line, or
//   2. cursor at the start of the line just after the (hidden) closing fence.
function dissolveFenceBackspace(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }
  const cursorLine = state.doc.lineAt(selection.head);
  if (selection.head !== cursorLine.from || cursorLine.number <= 1) {
    return false; // only at the very start of a line that has something above it
  }

  // The line above the cursor is either the opening fence (cursor at the first
  // content line) or the closing fence (cursor on the line just after a block).
  const aboveLine = state.doc.line(cursorLine.number - 1);
  let node = syntaxTree(state).resolveInner(aboveLine.from, 1);
  while (node && node.name !== 'FencedCode') {
    node = node.parent as typeof node;
  }
  if (!node) {
    return false;
  }
  const openLine = state.doc.lineAt(node.from);
  const closeLine = state.doc.lineAt(node.to);
  if (closeLine.number <= openLine.number || !CLOSE_FENCE_RE.test(closeLine.text)) {
    return false; // unterminated — nothing to dissolve yet
  }
  const firstContent = openLine.number + 1;
  const lastContent = closeLine.number - 1;
  const atContentStart = cursorLine.number === firstContent;
  const atAfterBlock = cursorLine.number === closeLine.number + 1;
  if (!atContentStart && !atAfterBlock) {
    return false;
  }
  const content =
    lastContent >= firstContent
      ? state.doc.sliceString(state.doc.line(firstContent).from, state.doc.line(lastContent).to)
      : '';
  view.dispatch({
    changes: { from: openLine.from, to: closeLine.to, insert: content },
    selection: { anchor: atAfterBlock ? openLine.from + content.length : openLine.from },
    scrollIntoView: true,
    userEvent: 'delete.dissolveFence',
  });
  return true;
}

// Returns the opening/closing lines of a closed fenced block whose opening
// fence sits on `lineNumber`, or null.
function closedFenceOpeningOnLine(state: EditorState, lineNumber: number) {
  if (lineNumber < 1 || lineNumber > state.doc.lines) {
    return null;
  }
  const line = state.doc.line(lineNumber);
  let node = syntaxTree(state).resolveInner(line.from, 1);
  while (node && node.name !== 'FencedCode') {
    node = node.parent as typeof node;
  }
  if (!node) {
    return null;
  }
  const openLine = state.doc.lineAt(node.from);
  const closeLine = state.doc.lineAt(node.to);
  if (openLine.number !== lineNumber || closeLine.number <= openLine.number || !CLOSE_FENCE_RE.test(closeLine.text)) {
    return null;
  }
  return { openLine, closeLine };
}

// The opening ``` is a chip, not editable text. Arrowing up/left off the first
// content line jumps to *before* the whole block instead of onto the chip line.
function fenceArrowUp(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }
  const line = state.doc.lineAt(selection.head);
  const block = closedFenceOpeningOnLine(state, line.number - 1);
  if (!block) {
    return false; // not the first content line of a block
  }
  const { openLine } = block;
  let anchor = openLine.from;
  if (openLine.number > 1) {
    const above = state.doc.line(openLine.number - 1);
    anchor = Math.min(above.from + (selection.head - line.from), above.to);
  }
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  return true;
}

function fenceArrowLeft(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.from) {
    return false; // only when leaving the start of the line
  }
  const block = closedFenceOpeningOnLine(state, line.number - 1);
  if (!block) {
    return false;
  }
  const anchor = block.openLine.from > 0 ? block.openLine.from - 1 : 0;
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  return true;
}

const fenceEnterKeymap = Prec.highest(
  keymap.of([
    { key: 'Enter', run: autoCloseFence },
    { key: 'Backspace', run: dissolveFenceBackspace },
    { key: 'ArrowUp', run: fenceArrowUp },
    { key: 'ArrowLeft', run: fenceArrowLeft },
  ]),
);

// A click in the empty area of the chip/header row would otherwise drop the
// cursor onto the raw opening-fence line; send it to the first content line
// instead. (Clicks on the chip itself stop propagation and open the dropdown.)
const fenceClickGuard = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) {
      return false;
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) {
      return false;
    }
    const line = view.state.doc.lineAt(pos);
    if (!closedFenceOpeningOnLine(view.state, line.number)) {
      return false;
    }
    event.preventDefault();
    view.dispatch({ selection: { anchor: view.state.doc.line(line.number + 1).from }, scrollIntoView: true });
    return true;
  },
});

// Cmd/Ctrl-click follows a link and opens it externally. A plain click still
// lands the cursor normally so URLs stay editable.
const linkClickHandler = EditorView.domEventHandlers({
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
const modifierKeyClass = ViewPlugin.fromClass(
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

const skipHiddenMarkdownKeymap = keymap.of([
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

const FENCE_RE = /^(\s*)(`{3,}|~{3,})([^`~]*)$/;
const CLOSE_FENCE_RE = /^\s*(`{3,}|~{3,})\s*$/;

// In CommonMark a content line made entirely of the fence character closes the
// block as soon as it is at least as long as the opening fence. So typing ``` on
// a line inside a ```-block prematurely ends it, leaving the rest as a stray,
// unterminated fence rendered as raw text. To let ``` live as content, grow the
// enclosing opening/closing fences to stay one character longer than the inner
// run (matching how GitHub renders nested fences).
const growFenceForInnerRun = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || !/[`~]/.test(text)) {
    return false;
  }
  const { state } = view;
  let node = syntaxTree(state).resolveInner(from, -1);
  while (node && node.name !== 'FencedCode') {
    node = node.parent as typeof node;
  }
  if (!node) {
    return false;
  }
  const openLine = state.doc.lineAt(node.from);
  const closeLine = state.doc.lineAt(node.to);
  if (closeLine.number <= openLine.number || !CLOSE_FENCE_RE.test(closeLine.text)) {
    return false; // unterminated block — nothing to keep open
  }
  const curLine = state.doc.lineAt(from);
  if (curLine.number <= openLine.number || curLine.number >= closeLine.number) {
    return false; // only act on content lines, never the fence rows themselves
  }
  const open = FENCE_RE.exec(openLine.text);
  if (!open) {
    return false;
  }
  const fenceChar = open[2][0];
  const openLen = open[2].length;
  // The content line as it would read after this insertion.
  const offset = from - curLine.from;
  const resulting = curLine.text.slice(0, offset) + text + curLine.text.slice(to - curLine.from);
  const runMatch = new RegExp(`^\\s*(\\${fenceChar}+)\\s*$`).exec(resulting);
  if (!runMatch || runMatch[1].length < openLen) {
    return false; // wouldn't act as a closing fence; let it type normally
  }
  // Grow both fences to one longer than the inner run so it stays content.
  const grow = fenceChar.repeat(runMatch[1].length + 1 - openLen);
  const openInsertAt = openLine.from + open[1].length;
  const closeInsertAt = closeLine.from + (/^(\s*)/.exec(closeLine.text)?.[1].length ?? 0);
  view.dispatch({
    changes: [
      { from: openInsertAt, insert: grow },
      { from, insert: text },
      { from: closeInsertAt, insert: grow },
    ],
    selection: { anchor: from + grow.length + text.length },
    scrollIntoView: true,
    userEvent: 'input.type',
  });
  return true;
});

// Typing a space right after `[]` or `- []` at the start of a line expands the
// shorthand into a canonical `- [ ] ` task item (which then renders as a box).
const checkboxAutoFormat = EditorView.inputHandler.of((view, from, to, text) => {
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

interface LanguageOption {
  name: string;
  token: string;
}

// Distinct languages offered in the chip dropdown, derived from the same list
// the parser uses so anything selectable is also highlightable.
const languageOptions: LanguageOption[] = (() => {
  const seen = new Set<string>();
  const options: LanguageOption[] = [];
  for (const desc of codeLanguages) {
    if (seen.has(desc.name)) {
      continue;
    }
    seen.add(desc.name);
    options.push({ name: desc.name, token: desc.alias[0] ?? desc.name.toLowerCase() });
  }
  options.sort((a, b) => a.name.localeCompare(b.name));
  return options;
})();

function languageLabel(info: string): string {
  const trimmed = info.trim();
  if (!trimmed) {
    return 'text';
  }
  const desc = LanguageDescription.matchLanguageName(codeLanguages, trimmed);
  return desc ? desc.name : trimmed;
}

// Rewrite the info string of the fence whose opening line starts at `linePos`.
function setFenceLanguage(view: EditorView, linePos: number, token: string) {
  const line = view.state.doc.lineAt(linePos);
  const match = FENCE_RE.exec(line.text);
  if (!match) {
    return;
  }
  const infoFrom = line.from + match[1].length + match[2].length;
  view.dispatch({
    changes: { from: infoFrom, to: line.to, insert: token },
    userEvent: 'input.complete',
  });
}

// Unwrap the fenced block whose opening line starts at `linePos`, leaving its
// content as plain text. Used by both the dismiss button and Backspace.
function dissolveBlockAt(view: EditorView, linePos: number) {
  const { state } = view;
  const openLine = state.doc.lineAt(linePos);
  let node = syntaxTree(state).resolveInner(openLine.from, 1);
  while (node && node.name !== 'FencedCode') {
    node = node.parent as typeof node;
  }
  if (!node) {
    return;
  }
  const closeLine = state.doc.lineAt(node.to);
  if (closeLine.number <= openLine.number || !CLOSE_FENCE_RE.test(closeLine.text)) {
    return;
  }
  const firstContent = openLine.number + 1;
  const lastContent = closeLine.number - 1;
  const content =
    lastContent >= firstContent
      ? state.doc.sliceString(state.doc.line(firstContent).from, state.doc.line(lastContent).to)
      : '';
  view.dispatch({
    changes: { from: openLine.from, to: closeLine.to, insert: content },
    selection: { anchor: openLine.from },
    userEvent: 'delete.dismissFence',
  });
  view.focus();
}

function openLanguageDropdown(view: EditorView, anchor: HTMLElement, linePos: number) {
  if (document.querySelector('.cm-lang-dropdown')) {
    return;
  }
  const panel = document.createElement('div');
  panel.className = 'cm-lang-dropdown morphSurface';
  const input = document.createElement('input');
  input.className = 'cm-lang-dropdown-input';
  input.type = 'text';
  input.placeholder = 'Search languages…';
  const list = document.createElement('div');
  list.className = 'cm-lang-dropdown-list morphScroll';
  // Padding lives on this inner wrapper (a child) rather than the panel so its
  // full height — bottom padding included — is counted in panel.scrollHeight when
  // the morph measures it. A scroll container's own bottom padding isn't.
  const content = document.createElement('div');
  content.className = 'cm-lang-dropdown-content';
  content.append(input, list);
  panel.append(content);

  document.body.appendChild(panel);

  // Drop below the whole code-block header (the chip lives *inside* it, so
  // anchoring to the chip would overlap the header). Left-align to the chip.
  const header = (anchor.closest('.cm-code-header') as HTMLElement | null) ?? anchor;

  // Keep the panel inside the viewport: clamp horizontally and flip above the
  // header when there isn't room below. A webview can't paint outside its window,
  // so an unconstrained `fixed` panel near an edge would just get clipped.
  const position = () => {
    const headerRect = header.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const gap = 0;

    let left = headerRect.left;
    const maxLeft = window.innerWidth - panelRect.width - margin;
    left = Math.min(Math.max(margin, left), Math.max(margin, maxLeft));

    const below = headerRect.bottom + gap;
    const fitsBelow = below + panelRect.height + margin <= window.innerHeight;
    const top = fitsBelow
      ? below
      : Math.max(margin, headerRect.top - gap - panelRect.height);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  };
  window.addEventListener('resize', position);

  let closing = false;
  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', position);
    // Collapse with the shared morph animation, then remove.
    morphClose(panel, () => panel.remove());
  };
  const onOutside = (event: MouseEvent) => {
    if (!panel.contains(event.target as Node)) {
      close();
    }
  };
  const choose = (token: string) => {
    setFenceLanguage(view, linePos, token);
    close();
    view.focus();
  };

  // `animate` adds the per-row fade only on the first render (the open). On later
  // re-renders (filtering) the whole list is rebuilt, so animating every row would
  // flicker on each keystroke — there we just re-fit the panel height instead.
  const render = (query: string, animate: boolean) => {
    const q = query.trim().toLowerCase();
    list.textContent = '';
    const options: LanguageOption[] = [{ name: 'Plain text', token: '' }, ...languageOptions];
    const filtered = q
      ? options.filter(option => option.name.toLowerCase().includes(q) || option.token.toLowerCase().includes(q))
      : options;
    for (const option of filtered.slice(0, 60)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = animate ? 'cm-lang-dropdown-item morphRow' : 'cm-lang-dropdown-item';
      item.textContent = option.name;
      item.addEventListener('mousedown', event => {
        event.preventDefault();
        choose(option.token);
      });
      list.appendChild(item);
    }
  };

  input.addEventListener('input', () => {
    render(input.value, false);
    // Grow/shrink the panel to fit the filtered list, then keep it on-screen.
    syncMorphHeight(panel);
    position();
  });
  input.addEventListener('keydown', event => {
    // Keep these keys local to the dropdown — otherwise they bubble to the
    // app-level window keydown handler, where Escape would hide the whole
    // overlay instead of just closing this menu.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      view.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const first = list.querySelector<HTMLButtonElement>('.cm-lang-dropdown-item');
      first?.dispatchEvent(new MouseEvent('mousedown'));
    }
  });

  render('', true);
  // Position using the full (natural) height, then grow the panel up from a
  // sliver into that height — the same morph the search island uses.
  position();
  morphOpen(panel);
  document.addEventListener('mousedown', onOutside, true);
  // preventScroll: the panel is mid-grow (clipped to a sliver), so a normal focus
  // would scroll the not-yet-revealed input into view and jolt the page.
  input.focus({ preventScroll: true });
}

// Block-level header that stands in for the opening ``` line. Being a block
// widget, it is non-editable: the cursor cannot land on the header row at all,
// only in the content below.
class FenceHeaderWidget extends WidgetType {
  constructor(readonly label: string, readonly linePos: number) {
    super();
  }

  eq(other: FenceHeaderWidget) {
    return other.label === this.label && other.linePos === this.linePos;
  }

  toDOM(view: EditorView) {
    const header = document.createElement('div');
    header.className = 'cm-code-header';
    header.contentEditable = 'false';

    const chip = document.createElement('span');
    chip.className = 'cm-code-lang-chip';
    if (this.label === 'text') {
      chip.classList.add('cm-code-lang-chip-empty');
    }
    chip.textContent = this.label;
    chip.addEventListener('mousedown', event => event.preventDefault());
    chip.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openLanguageDropdown(view, chip, this.linePos);
    });

    const dismiss = document.createElement('button');
    dismiss.className = 'cm-code-dismiss';
    dismiss.type = 'button';
    dismiss.title = 'Dismiss code block';
    dismiss.setAttribute('aria-label', 'Dismiss code block');
    dismiss.textContent = '✕';
    dismiss.addEventListener('mousedown', event => event.preventDefault());
    dismiss.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      dissolveBlockAt(view, this.linePos);
    });

    header.append(chip, dismiss);
    return header;
  }

  ignoreEvent() {
    return false;
  }
}

interface CodeBlockDecorations {
  deco: DecorationSet;
  atomic: DecorationSet;
}

function buildCodeBlockDecorations(state: EditorState): CodeBlockDecorations {
  const decorations: Array<Range<Decoration>> = [];
  const atomic: Array<Range<Decoration>> = [];
  const tree = syntaxTree(state);
  tree.iterate({
    enter: node => {
      if (node.name !== 'FencedCode') {
        return;
      }
      const openLine = state.doc.lineAt(node.from);
      const endLine = state.doc.lineAt(node.to);

      // Only style a *terminated* block. An unterminated fence (still being
      // typed) extends to the end of the document and would otherwise swallow
      // everything below it into one giant box.
      const closed = endLine.number > openLine.number && CLOSE_FENCE_RE.test(endLine.text);
      if (!closed) {
        return;
      }
      const firstContentLine = openLine.number + 1;
      const lastContentLine = endLine.number - 1;

      // Content rows form the body of the box (the header widget below is the
      // top edge). The first content row gets no top rounding; the last gets the
      // rounded bottom.
      for (let lineNumber = firstContentLine; lineNumber <= lastContentLine; lineNumber += 1) {
        const line = state.doc.line(lineNumber);
        const classes = ['cm-code-block-line'];
        if (lineNumber === firstContentLine) {
          classes.push('cm-code-block-body-first');
        }
        if (lineNumber === lastContentLine) {
          classes.push('cm-code-block-last');
        }
        decorations.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
      }

      // Opening fence → block-level header (chip + dismiss). As a block widget it
      // is non-editable, so the cursor can never sit on the header row — only in
      // the content below.
      const info = FENCE_RE.exec(openLine.text)?.[3] ?? '';
      decorations.push(
        Decoration.replace({
          widget: new FenceHeaderWidget(languageLabel(info), openLine.from),
          block: true,
        }).range(openLine.from, openLine.to),
      );

      // Closing fence → collapse to zero height. Replace only the line's own
      // content (not the preceding newline) so the last code line above keeps
      // an addressable cursor position even when it is empty.
      decorations.push(Decoration.replace({ block: true }).range(endLine.from, endLine.to));

      // Both fence lines are atomic: cursor motion and deletion skip over them
      // rather than landing on the hidden ``` markers.
      atomic.push(Decoration.mark({}).range(openLine.from, openLine.to));
      atomic.push(Decoration.mark({}).range(endLine.from, endLine.to));
    },
  });
  return { deco: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

const codeBlockLineDecorations = StateField.define<CodeBlockDecorations>({
  create: state => buildCodeBlockDecorations(state),
  update(value, transaction) {
    // Rebuild on edits and when the markdown parser advances the tree (so blocks
    // render/highlight as soon as they parse). Decorations no longer depend on
    // the selection, so cursor moves alone don't trigger a rebuild.
    if (transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return buildCodeBlockDecorations(transaction.state);
    }
    return { deco: value.deco.map(transaction.changes), atomic: value.atomic.map(transaction.changes) };
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.deco),
    EditorView.atomicRanges.of(view => view.state.field(field).atomic),
  ],
});

// Block-level image previews live in a StateField (not the ViewPlugin above):
// CodeMirror rejects block decorations supplied by a plugin, so they must be
// provided through the editor state.
function buildImagePreviewDecorations(state: EditorState): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    const line = state.doc.line(lineNumber);
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
  return Decoration.set(decorations, true);
}

const imagePreviewDecorations = StateField.define<DecorationSet>({
  create: state => buildImagePreviewDecorations(state),
  update(value, transaction) {
    if (transaction.docChanged) {
      return buildImagePreviewDecorations(transaction.state);
    }
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

const headingLineDecorations = ViewPlugin.fromClass(
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

interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function saveWindowFrame() {
  if (!IS_TAURI) {
    return;
  }
  const current = getCurrentWindow();
  const [position, size] = await Promise.all([current.outerPosition(), current.outerSize()]);
  const frame: WindowFrame = {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
  window.localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
  window.localStorage.setItem(FRAME_SHAPE_KEY, CURRENT_FRAME_SHAPE);
}

async function restoreWindowFrame() {
  if (!IS_TAURI) {
    return;
  }

  if (window.localStorage.getItem(FRAME_SHAPE_KEY) !== CURRENT_FRAME_SHAPE) {
    window.localStorage.removeItem(FRAME_KEY);
    window.localStorage.setItem(FRAME_SHAPE_KEY, CURRENT_FRAME_SHAPE);
    return;
  }

  const raw = window.localStorage.getItem(FRAME_KEY);
  if (!raw) {
    return;
  }
  let frame: WindowFrame;
  try {
    frame = JSON.parse(raw) as WindowFrame;
  } catch {
    // Corrupted/hand-edited value: drop it and fall back to the default frame.
    window.localStorage.removeItem(FRAME_KEY);
    return;
  }
  const current = getCurrentWindow();
  await current.setSize(new PhysicalSize(frame.width, frame.height));
  await current.setPosition(new PhysicalPosition(frame.x, frame.y));
}

// Shared filled glyphs used by both the React suggestion list and the
// DOM-rendered CodeMirror completion popup, so files and directories look the
// same wherever paths are completed. Solid silhouettes (the file keeps its cut
// top-right corner) so they read clearly when tinted solid pink.
const FILE_ICON_PATH = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z';
const FOLDER_ICON_PATH =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';

function PathGlyph({ isDir }: { isDir: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d={isDir ? FOLDER_ICON_PATH : FILE_ICON_PATH} />
    </svg>
  );
}

// DOM equivalent of PathGlyph for CodeMirror's completion popup, which renders
// plain nodes rather than React elements.
const SVG_NS = 'http://www.w3.org/2000/svg';

function pathGlyphNode(isDir: boolean): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'cm-pathCompletionIcon';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', isDir ? FOLDER_ICON_PATH : FILE_ICON_PATH);
  svg.appendChild(path);
  wrap.appendChild(svg);
  return wrap;
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

async function hideOverlay() {
  await saveWindowFrame();
  if (IS_TAURI) {
    await getCurrentWindow().hide();
  }
}

interface PathSuggestion {
  value: string;
  label: string;
  isDir: boolean;
}

// A text input that offers filesystem path completions while the value looks
// like a path (starts with `/`, `./`, `../`, or `~/`). Suggestions come from
// the `suggest_paths` Tauri command; outside Tauri it degrades to a plain input.
function PathInput({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const [suggestions, setSuggestions] = React.useState<PathSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const requestId = React.useRef(0);

  const refresh = React.useCallback((next: string) => {
    if (!IS_TAURI) {
      return;
    }
    const id = ++requestId.current;
    void invoke<PathSuggestion[]>('suggest_paths', { input: next, filter: 'dirs' })
      .then(results => {
        // Ignore responses that lost the race to a newer keystroke.
        if (id !== requestId.current) {
          return;
        }
        setSuggestions(results);
        setActiveIndex(0);
        setOpen(results.length > 0);
      })
      .catch(() => {
        if (id === requestId.current) {
          setSuggestions([]);
          setOpen(false);
        }
      });
  }, []);

  const accept = React.useCallback(
    (suggestion: PathSuggestion) => {
      onChange(suggestion.value);
      // Drilling into a folder should immediately list its contents; landing on
      // a file just fills the value and closes the menu.
      if (suggestion.isDir) {
        refresh(suggestion.value);
      } else {
        setOpen(false);
      }
    },
    [onChange, refresh],
  );

  return (
    <div className="pathInput">
      <input
        value={value}
        onChange={event => {
          const next = event.target.value;
          onChange(next);
          refresh(next);
        }}
        onFocus={() => refresh(value)}
        onBlur={() => {
          // Delay so a suggestion click registers before the menu unmounts.
          window.setTimeout(() => setOpen(false), 120);
          onCommit();
        }}
        onKeyDown={event => {
          if (!open || suggestions.length === 0) {
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex(index => Math.min(index + 1, suggestions.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(index => Math.max(index - 1, 0));
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            accept(suggestions[activeIndex]);
          } else if (event.key === 'Escape') {
            // Dismiss only the suggestion list; don't let Escape bubble to the
            // app handler and close the surrounding settings panel too.
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && suggestions.length > 0 ? (
        <ul className="pathSuggestions" role="listbox">
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.value}
              className={index === activeIndex ? 'pathSuggestion pathSuggestion-active' : 'pathSuggestion'}
              role="option"
              aria-selected={index === activeIndex}
              onMouseMove={() => setActiveIndex(index)}
              onMouseDown={event => {
                // Keep focus on the input so onBlur's commit stays in order.
                event.preventDefault();
                accept(suggestion);
              }}
            >
              <span className="pathSuggestionIcon">
                <PathGlyph isDir={suggestion.isDir} />
              </span>
              <span className="pathSuggestionLabel">{suggestion.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Cursor sits inside the `(...)` target of a markdown link `[](…)` or image
// `![](…)`; capture the partial path typed so far (link targets have no spaces).
const LINK_TARGET_RE = /!?\[[^\]]*\]\(([^()\s]*)$/;

function applyPathCompletion(suggestion: PathSuggestion) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: suggestion.value },
      selection: { anchor: from + suggestion.value.length },
      userEvent: 'input.complete',
    });
    // Drilling into a folder should immediately list its contents.
    if (suggestion.isDir) {
      startCompletion(view);
    }
  };
}

// Completes filesystem paths typed inside a markdown link/image target once the
// fragment looks like a path (`/`, `./`, `../`, `~/`). Files and directories are
// both offered — directories so you can keep drilling down to the file you want.
async function pathCompletionSource(context: CompletionContext): Promise<CompletionResult | null> {
  if (!IS_TAURI) {
    return null;
  }
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = LINK_TARGET_RE.exec(before);
  if (!match) {
    return null;
  }
  const fragment = match[1];
  if (!/^(\/|\.\/|\.\.\/|~\/)/.test(fragment)) {
    return null;
  }

  let suggestions: PathSuggestion[];
  try {
    suggestions = await invoke<PathSuggestion[]>('suggest_paths', { input: fragment, filter: 'all' });
  } catch {
    return null;
  }
  if (suggestions.length === 0) {
    return null;
  }

  return {
    from: context.pos - fragment.length,
    to: context.pos,
    // The Rust side already prefix-filtered; let it own the ordering.
    filter: false,
    options: suggestions.map(suggestion => ({
      label: suggestion.label,
      // A folder/file glyph (added via addToOptions below) distinguishes the
      // two, so no plaintext "folder" detail is needed.
      type: suggestion.isDir ? 'folder' : 'file',
      apply: applyPathCompletion(suggestion),
    })),
  };
}

function useDebouncedSave(
  state: NoteState,
  setState: React.Dispatch<React.SetStateAction<NoteState>>,
  noteGenRef: React.RefObject<number>,
) {
  React.useEffect(() => {
    if (state.status === 'loading' || state.content === state.savedContent) {
      return;
    }

    const handle = window.setTimeout(() => {
      // Stamp the active note; if it changes (new note / opened another) before
      // this async save resolves, its result must not be applied to whatever note
      // is now in the editor.
      const gen = noteGenRef.current;
      setState(prev => ({ ...prev, status: 'saving', message: 'Saving…' }));
      if (!IS_TAURI) {
        window.localStorage.setItem('nanotes:browserPreviewContent', state.content);
        setState(prev => ({ ...prev, savedContent: prev.content, status: 'saved', message: 'Preview saved' }));
        return;
      }
      void invoke<NoteSaveResult>('write_note', {
        notesDir: state.notesDir,
        notePath: state.notePath,
        content: state.content,
      })
        .then(result => {
          if (noteGenRef.current !== gen) {
            return;
          }
          window.localStorage.setItem('nanotes:notePath', result.path);
          setState(prev => ({
            ...prev,
            notePath: result.path,
            savedContent: prev.content,
            status: 'saved',
            message: 'Saved',
          }));
        })
        .catch((error: unknown) => {
          if (noteGenRef.current !== gen) {
            return;
          }
          setState(prev => ({
            ...prev,
            status: 'error',
            message: String(error),
          }));
        });
    }, SAVE_DELAY_MS);

    return () => window.clearTimeout(handle);
  }, [state.content, state.notePath, state.savedContent, state.status, state.notesDir, setState, noteGenRef]);
}

function App() {
  const [state, setState] = React.useState<NoteState>({
    // `||` (not `??`) so a stored empty string falls back to the default rather
    // than loading the folder field blank.
    notesDir: window.localStorage.getItem('nanotes:notesDir')?.trim() || DEFAULT_NOTES_DIR,
    notePath: storedNotePath(),
    content: '',
    savedContent: '',
    status: 'idle',
    message: 'Ready',
  });
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [hotkey, setHotkey] = React.useState<string>(
    () => window.localStorage.getItem(HOTKEY_KEY)?.trim() || DEFAULT_HOTKEY,
  );
  const [recordingHotkey, setRecordingHotkey] = React.useState(false);
  const [launchAtLogin, setLaunchAtLogin] = React.useState(false);
  const [launchAtLoginReady, setLaunchAtLoginReady] = React.useState(!IS_TAURI);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [notes, setNotes] = React.useState<NoteEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [pinnedPaths, setPinnedPaths] = React.useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(PINNED_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  // The live CodeMirror view, so commands like "new note" can move focus back to
  // the editor immediately instead of leaving it on whatever was last focused.
  const editorViewRef = React.useRef<EditorView | null>(null);
  // Always-current snapshot of state so the switch-note commands can flush the
  // outgoing note's pending edits without recreating their callbacks on every
  // keystroke (which would also keep re-subscribing the global key listener).
  const stateRef = React.useRef(state);
  stateRef.current = state;
  // Bumped on every note switch. In-flight saves capture the value at fire time
  // and drop their result if it changed, so a slow save from the previous note
  // never lands on (and appears to block) the note now in the editor.
  const noteGenRef = React.useRef(0);
  // The notes directory currently loaded into the editor. The settings field
  // commits on every blur, so this lets loadNote ignore commits that don't
  // actually change the folder (see loadNote).
  const loadedDirRef = React.useRef<string | null>(null);

  // Persist the note currently in the editor if it has unsaved changes. The
  // debounced autosave is cancelled the instant we switch notes, so without this
  // the last edits (within the debounce window) would be dropped. The outgoing
  // note is snapshotted synchronously, but the write is deferred to a macrotask
  // so switching notes paints first — the save never sits on the critical path.
  const flushPendingSave = React.useCallback(() => {
    const current = stateRef.current;
    if (!IS_TAURI || current.content === current.savedContent) {
      return;
    }
    window.setTimeout(() => {
      void invoke<NoteSaveResult>('write_note', {
        notesDir: current.notesDir,
        notePath: current.notePath,
        content: current.content,
      }).catch(() => undefined);
    }, 0);
  }, []);

  const focusEditor = React.useCallback(() => {
    // Defer to the next frame so the new document has been mounted before we
    // place the cursor and focus.
    requestAnimationFrame(() => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
  }, []);

  const extensions = React.useMemo(
    () => [
      history(),
      drawSelection(),
      checkboxAutoFormat,
      growFenceForInnerRun,
      fenceEnterKeymap,
      fenceClickGuard,
      linkClickHandler,
      modifierKeyClass,
      skipHiddenMarkdownKeymap,
      // Tab accepts the highlighted path completion; acceptCompletion returns
      // false when no popup is open, so Tab still indents normally otherwise.
      // Prec.highest so it beats every other keymap regardless of array order.
      Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // Drop SetextHeading so a `-` line under text is parsed as a list bullet,
      // not as the `---` underline that would turn the paragraph above into a heading.
      markdown({ codeLanguages, extensions: [{ remove: ['SetextHeading'] }] }),
      autocompletion({
        override: [pathCompletionSource],
        icons: false,
        // No accidental-accept guard: this is a controlled editor that
        // re-renders each keystroke, resetting the popup timestamp, so the
        // default 75ms delay would make Tab/Enter silently no-op right after
        // typing.
        interactionDelay: 0,
        // Render our own folder/file glyph ahead of the label (position < 50).
        addToOptions: [
          {
            render: completion => pathGlyphNode(completion.type === 'folder'),
            position: 20,
          },
        ],
      }),
      syntaxHighlighting(markdownHighlight),
      codeBlockLineDecorations,
      EditorView.lineWrapping,
      editorTheme,
      headingLineDecorations,
      imagePreviewDecorations,
    ],
    [],
  );

  const loadNote = React.useCallback(() => {
    // An empty/whitespace folder isn't a valid target; fall back to the default
    // and reflect it back into the field so it never sits blank.
    const notesDir = state.notesDir.trim() || DEFAULT_NOTES_DIR;
    // Nothing to reload if the folder hasn't actually changed since the last
    // load (e.g. blurring the settings field without editing it). Re-reading
    // would be wasted work and would clobber in-memory edits not yet flushed —
    // just normalise a blank/whitespace field back to the resolved value.
    if (loadedDirRef.current === notesDir) {
      if (notesDir !== state.notesDir) {
        setState(prev => ({ ...prev, notesDir }));
      }
      return;
    }
    loadedDirRef.current = notesDir;
    noteGenRef.current += 1;
    setState(prev => ({ ...prev, notesDir, status: 'loading', message: 'Loading…' }));
    if (!IS_TAURI) {
      const content = window.localStorage.getItem('nanotes:browserPreviewContent') ?? SAMPLE_NOTE;
      setState(prev => ({
        ...prev,
        content,
        savedContent: content,
        status: 'saved',
        message: 'Browser preview',
      }));
      return;
    }
    void invoke<string>('read_note', {
      notesDir,
      notePath: state.notePath,
    })
      .then(content => {
        window.localStorage.setItem('nanotes:notesDir', notesDir);
        window.localStorage.setItem('nanotes:notePath', state.notePath);
        setState(prev => ({
          ...prev,
          content,
          savedContent: content,
          status: 'saved',
          message: 'Saved',
        }));
      })
      .catch((error: unknown) => {
        // Forget the failed directory so committing again retries the load.
        loadedDirRef.current = null;
        setState(prev => ({
          ...prev,
          status: 'error',
          message: String(error),
        }));
      });
  }, [state.notePath, state.notesDir]);

  const openNote = React.useCallback((notePath: string) => {
    flushPendingSave();
    noteGenRef.current += 1;
    setSearchOpen(false);
    setSearchQuery('');
    setSettingsOpen(false);
    setState(prev => ({ ...prev, notePath, status: 'loading', message: 'Loading…' }));

    if (!IS_TAURI) {
      // No filesystem to read from in browser preview; just settle the status.
      setState(prev => ({ ...prev, status: 'saved', message: 'Browser preview' }));
      focusEditor();
      return;
    }

    void invoke<string>('read_note', {
      notesDir: stateRef.current.notesDir,
      notePath,
    })
      .then(content => {
        window.localStorage.setItem('nanotes:notePath', notePath);
        setState(prev => ({ ...prev, notePath, content, savedContent: content, status: 'saved', message: 'Saved' }));
        focusEditor();
      })
      .catch((error: unknown) => {
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [flushPendingSave, focusEditor]);

  const createNewNote = React.useCallback(() => {
    flushPendingSave();
    noteGenRef.current += 1;
    setSearchOpen(false);
    setSettingsOpen(false);
    // Clear the editor imperatively so the new note appears the same frame,
    // independent of React re-rendering and the controlled-value sync (which
    // stalls when keystrokes/renders from rapid typing are still in flight —
    // that was the lag when creating a note right after typing).
    const view = editorViewRef.current;
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
      view.focus();
    }
    // Purely in-memory: no IPC, no file written. The empty notePath marks an
    // unsaved new note; the file is created (with a unique name picked by
    // write_note) only once the user types and the autosave fires.
    setState(prev => ({ ...prev, notePath: '', content: '', savedContent: '', status: 'saved', message: 'New note' }));
    window.localStorage.removeItem('nanotes:notePath');

    if (!IS_TAURI) {
      window.localStorage.setItem('nanotes:browserPreviewContent', '');
    }
  }, [flushPendingSave]);

  const openSearch = React.useCallback(() => {
    setSearchOpen(true);
    setSettingsOpen(false);
    setSearchQuery('');

    // The Tauri note list is fetched by the searchOpen/searchQuery effect below;
    // here we only seed the browser-preview list, which that effect skips.
    if (!IS_TAURI) {
      setNotes([{ path: DEFAULT_NOTE, title: 'NaNotes', modifiedMs: 0 }]);
    }
  }, []);

  const togglePin = React.useCallback((notePath: string) => {
    setPinnedPaths(prev => {
      const next = prev.includes(notePath) ? prev.filter(path => path !== notePath) : [...prev, notePath];
      window.localStorage.setItem(PINNED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const deleteNote = React.useCallback((notePath: string) => {
    setPinnedPaths(prev => {
      const next = prev.filter(path => path !== notePath);
      window.localStorage.setItem(PINNED_KEY, JSON.stringify(next));
      return next;
    });

    if (!IS_TAURI) {
      setNotes(prev => prev.filter(note => note.path !== notePath));
      return;
    }

    void invoke('delete_note', { notesDir: state.notesDir, notePath })
      .then(() => invoke<NoteEntry[]>('list_notes', { notesDir: state.notesDir, query: searchQuery }))
      .then(setNotes)
      .catch((error: unknown) => {
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [searchQuery, state.notesDir]);

  const toggleLaunchAtLogin = React.useCallback(() => {
    if (!IS_TAURI || !launchAtLoginReady) {
      return;
    }

    const next = !launchAtLogin;
    setLaunchAtLogin(next);
    setState(prev => ({ ...prev, status: 'saving', message: next ? 'Enabling login launch…' : 'Disabling login launch…' }));
    void (next ? enableAutostart() : disableAutostart())
      .then(() => {
        setState(prev => ({ ...prev, status: 'saved', message: next ? 'Launch at login enabled' : 'Launch at login disabled' }));
      })
      .catch((error: unknown) => {
        setLaunchAtLogin(!next);
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [launchAtLogin, launchAtLoginReady]);

  // Persist the chosen hotkey and (re)register it with the backend whenever it
  // changes. This also runs once on mount to apply the stored override over the
  // backend's compiled-in default. The very first run is silent so it doesn't
  // clobber the initial "Ready" status; later changes report success/failure.
  const hotkeyAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (!IS_TAURI) {
      window.localStorage.setItem(HOTKEY_KEY, hotkey);
      return;
    }
    const isInitial = !hotkeyAppliedRef.current;
    hotkeyAppliedRef.current = true;
    void invoke('set_hotkey', { accelerator: hotkey })
      .then(() => {
        // Only persist once the backend has accepted the combo, so a rejected
        // accelerator never becomes the value reloaded (broken) on next launch.
        window.localStorage.setItem(HOTKEY_KEY, hotkey);
        if (!isInitial) {
          setState(prev => ({ ...prev, status: 'saved', message: `Hotkey set to ${formatHotkey(hotkey)}` }));
        }
      })
      .catch((error: unknown) => {
        setState(prev => ({ ...prev, status: 'error', message: `Hotkey: ${String(error)}` }));
      });
  }, [hotkey]);

  // Latest hotkey, readable from the recording effect's cleanup without making
  // the effect depend on (and thus restart on) every hotkey change.
  const hotkeyRef = React.useRef(hotkey);
  hotkeyRef.current = hotkey;

  // While recording, listen for the next combo on the window in the capture
  // phase so it lands regardless of focus and beats CodeMirror / global key
  // handlers (which would otherwise eat the press). The live OS shortcut is
  // suspended for the duration so pressing the current hotkey gets recorded
  // instead of toggling the overlay; it's re-armed when recording ends.
  React.useEffect(() => {
    if (!recordingHotkey) {
      return;
    }
    if (IS_TAURI) {
      void invoke('clear_hotkey').catch(() => undefined);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        setRecordingHotkey(false);
        return;
      }
      // Ignore lone modifier presses — keep listening until a real key arrives.
      if (HOTKEY_MODIFIER_CODES.has(event.code)) {
        return;
      }
      const modifiers: string[] = [];
      if (event.metaKey) modifiers.push('super');
      if (event.ctrlKey) modifiers.push('control');
      if (event.altKey) modifiers.push('alt');
      if (event.shiftKey) modifiers.push('shift');
      if (modifiers.length === 0) {
        setState(prev => ({ ...prev, status: 'error', message: 'Hotkey needs a modifier (⌘, ⌥, ⌃, or ⇧)' }));
        return;
      }
      setHotkey([...modifiers, event.code].join('+'));
      setRecordingHotkey(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      // Re-arm the shortcut. If a new combo was captured, the hotkey effect
      // re-registers it right after this cleanup, making this a harmless no-op.
      if (IS_TAURI) {
        void invoke('set_hotkey', { accelerator: hotkeyRef.current }).catch(() => undefined);
      }
    };
  }, [recordingHotkey]);

  // Load the initial note once on mount. Subsequent folder/note changes are
  // driven explicitly by loadNote/openNote/createNewNote, so loadNote is
  // deliberately omitted from the dependency list.
  React.useEffect(() => {
    loadNote();
  }, []);

  React.useEffect(() => {
    if (!IS_TAURI) {
      return;
    }

    void isAutostartEnabled()
      .then(enabled => {
        setLaunchAtLogin(enabled);
        setLaunchAtLoginReady(true);
      })
      .catch(() => {
        setLaunchAtLoginReady(true);
      });
  }, []);

  React.useEffect(() => {
    if (!searchOpen || !IS_TAURI) {
      return;
    }

    void invoke<NoteEntry[]>('list_notes', { notesDir: state.notesDir, query: searchQuery })
      .then(setNotes)
      .catch((error: unknown) => {
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [searchOpen, searchQuery, state.notesDir]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isAppShortcut = IS_LINUX
        ? event.altKey && !event.metaKey && !event.ctrlKey
        : event.metaKey && !event.ctrlKey && !event.altKey;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        void hideOverlay();
        return;
      }

      if (!isAppShortcut) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        setSearchOpen(false);
        setSettingsOpen(value => !value);
      } else if (key === 'n') {
        event.preventDefault();
        createNewNote();
      } else if (key === 'p') {
        event.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
        } else {
          openSearch();
        }
      } else if (key === 'q') {
        event.preventDefault();
        void hideOverlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createNewNote, openSearch, searchOpen, settingsOpen]);

  React.useEffect(() => {
    let timer: number | undefined;
    let disposed = false;
    let cleanup: Array<() => void> = [];
    if (!IS_TAURI) {
      return;
    }
    const current = getCurrentWindow();
    const queueSave = () => {
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => void saveWindowFrame(), 250);
    };

    void restoreWindowFrame();
    void Promise.all([current.listen('tauri://move', queueSave), current.listen('tauri://resize', queueSave)]).then(
      unlisteners => {
        cleanup = unlisteners;
        if (disposed) {
          unlisteners.forEach(unlisten => unlisten());
        }
      },
    );

    return () => {
      disposed = true;
      if (timer) {
        window.clearTimeout(timer);
      }
      cleanup.forEach(unlisten => unlisten());
    };
  }, []);

  useDebouncedSave(state, setState, noteGenRef);

  const filteredNotes = React.useMemo(() => {
    const pinnedSet = new Set(pinnedPaths);
    const ordered = [...notes].sort((a, b) => Number(pinnedSet.has(b.path)) - Number(pinnedSet.has(a.path)));
    return ordered.slice(0, 10);
  }, [notes, pinnedPaths]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [filteredNotes, searchOpen]);

  // The search "island" morphs from a pill into a panel that grows downward over
  // the editor (Dynamic-Island style), via the shared morph animation. The hook
  // measures the open content height and feeds it back as the inline height so
  // CSS can transition the grow/shrink — on open/close and as results change. At
  // rest the height is left unset so the CSS pill height shows through.
  const { ref: islandRef, height: islandHeight } = useMorphHeight<HTMLDivElement>(searchOpen, [filteredNotes]);

  return (
    <main className="shell">
      <header className="topbar" data-tauri-drag-region>
        <div
          className={searchOpen ? 'morphSurface island island-open' : 'morphSurface island'}
          ref={islandRef}
          style={islandHeight !== undefined ? { height: islandHeight } : undefined}
        >
          {searchOpen ? (
            <div className="islandBar">
              <svg className="topbarSearchIcon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
              <input
                autoFocus
                className="topbarSearchInput"
                placeholder="Search notes…"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSelectedIndex(index => Math.min(index + 1, filteredNotes.length - 1));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSelectedIndex(index => Math.max(index - 1, 0));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    const note = filteredNotes[selectedIndex];
                    if (note) {
                      openNote(note.path);
                    }
                  }
                }}
              />
            </div>
          ) : (
            <button
              className="islandBar"
              type="button"
              aria-label="Search notes"
              title={`Search notes (${appShortcutLabel('P')})`}
              onClick={openSearch}
            >
              <svg className="topbarSearchIcon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
              <span className="topbarSearchLabel">{titleFromContent(state.content)}</span>
            </button>
          )}
          {searchOpen ? (
            <div className="islandResults">
              <div className="noteResults morphScroll">
                {filteredNotes.map((note, index) => {
                  const pinned = pinnedPaths.includes(note.path);
                  const classNames = ['noteResult', 'morphRow'];
                  if (index === selectedIndex) {
                    classNames.push('noteResult-active');
                  }
                  if (pinned) {
                    classNames.push('noteResult-pinned');
                  }
                  return (
                    <div
                      key={note.path}
                      ref={element => {
                        if (index === selectedIndex) {
                          element?.scrollIntoView({ block: 'nearest' });
                        }
                      }}
                      className={classNames.join(' ')}
                      role="option"
                      aria-selected={index === selectedIndex}
                      onMouseMove={() => setSelectedIndex(index)}
                      onClick={() => openNote(note.path)}
                    >
                      <span className="noteResultTitle">{note.title}</span>
                      <span className="noteResultActions">
                        <button
                          aria-label={pinned ? 'Unpin note' : 'Pin note'}
                          aria-pressed={pinned}
                          className="noteResultAction noteResultAction-pin"
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            togglePin(note.path);
                          }}
                        >
                          <PinIcon filled={pinned} />
                        </button>
                        <button
                          aria-label="Delete note"
                          className="noteResultAction noteResultAction-delete"
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            deleteNote(note.path);
                          }}
                        >
                          <TrashIcon />
                        </button>
                      </span>
                    </div>
                  );
                })}
                {filteredNotes.length === 0 ? <div className="emptyResults">No notes found</div> : null}
              </div>
            </div>
          ) : null}
        </div>
        <div className="topbarActions">
          <button
            className="topbarButton"
            type="button"
            aria-label="New note"
            title={`New note (${appShortcutLabel('N')})`}
            onClick={createNewNote}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
      </header>

      {settingsOpen ? (
        <div className="settingsOverlay" role="dialog" aria-modal="true" aria-label="Settings">
          <header className="settingsHeader">
            <h2 className="settingsTitle">Settings</h2>
            <button
              className="settingsClose"
              type="button"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </header>
          <div className="settingsBody">
            <label>
              <span>Notes folder</span>
              <PathInput
                value={state.notesDir}
                onChange={notesDir => setState(prev => ({ ...prev, notesDir }))}
                onCommit={loadNote}
              />
            </label>

            <div className="settingRow">
              <strong>New note hotkey</strong>
              <button
                className={recordingHotkey ? 'hotkeyButton hotkeyButton-recording' : 'hotkeyButton'}
                type="button"
                aria-label="Change new note hotkey"
                onClick={() => setRecordingHotkey(recording => !recording)}
                onBlur={() => setRecordingHotkey(false)}
              >
                {recordingHotkey ? 'Press keys…' : formatHotkey(hotkey)}
              </button>
            </div>

            <div className="settingRow">
              <strong>Launch at login</strong>
              <button
                className={launchAtLogin ? 'switch switch-on' : 'switch'}
                role="switch"
                aria-checked={launchAtLogin}
                aria-label="Launch at login"
                disabled={!launchAtLoginReady}
                type="button"
                onClick={toggleLaunchAtLogin}
              >
                <span className="switchKnob" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className={settingsOpen ? 'editorShell editorShell-hidden' : 'editorShell'}>
        <CodeMirror
          autoFocus
          basicSetup={false}
          extensions={extensions}
          height="100%"
          placeholder="Start typing…"
          theme="dark"
          value={state.content}
          onCreateEditor={view => {
            editorViewRef.current = view;
          }}
          onChange={value => setState(prev => ({ ...prev, content: value }))}
        />
      </section>

    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
