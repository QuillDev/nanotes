import { LanguageDescription, syntaxTree } from '@codemirror/language';
import { EditorState, Prec, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import { morphClose, morphOpen, syncMorphHeight } from '../morph';
import { codeLanguages } from './theme';

const FENCE_RE = /^(\s*)(`{3,}|~{3,})([^`~]*)$/;
const CLOSE_FENCE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const BACKTICK_RUN_RE = /^\s*(`+)\s*$/;
const TILDE_RUN_RE = /^\s*(~+)\s*$/;

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
  const match = FENCE_RE.exec(line.text);
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

export const fenceEnterKeymap = Prec.highest(
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
export const fenceClickGuard = EditorView.domEventHandlers({
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

// In CommonMark a content line made entirely of the fence character closes the
// block as soon as it is at least as long as the opening fence. So typing ``` on
// a line inside a ```-block prematurely ends it, leaving the rest as a stray,
// unterminated fence rendered as raw text. To let ``` live as content, grow the
// enclosing opening/closing fences to stay one character longer than the inner
// run (matching how GitHub renders nested fences).
export const growFenceForInnerRun = EditorView.inputHandler.of((view, from, to, text) => {
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
  const runMatch = (fenceChar === '`' ? BACKTICK_RUN_RE : TILDE_RUN_RE).exec(resulting);
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
  constructor(readonly label: string) {
    super();
  }

  eq(other: FenceHeaderWidget) {
    return other.label === this.label;
  }

  toDOM(view: EditorView) {
    const header = document.createElement('div');
    header.className = 'cm-code-header';
    header.contentEditable = 'false';

    const resolveLinePos = () => {
      const pos = view.posAtDOM(header);
      return view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).from;
    };

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
      openLanguageDropdown(view, chip, resolveLinePos());
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
      dissolveBlockAt(view, resolveLinePos());
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

const FENCE_CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

function buildCodeBlockDecorations(state: EditorState): CodeBlockDecorations {
  const decorations: Array<Range<Decoration>> = [];
  const atomic: Array<Range<Decoration>> = [];
  const tree = syntaxTree(state);
  tree.iterate({
    enter: node => {
      if (node.name !== 'FencedCode') {
        return FENCE_CONTAINERS.has(node.name) ? undefined : false;
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
          widget: new FenceHeaderWidget(languageLabel(info)),
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
      return false;
    },
  });
  return { deco: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

export const codeBlockLineDecorations = StateField.define<CodeBlockDecorations>({
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
