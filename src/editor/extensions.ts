import {
  acceptCompletion,
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { FILE_ICON_PATH, FOLDER_ICON_PATH } from '../components/Icons';
import { IS_TAURI, type PathSuggestion } from '../desktop/config';
import {
  codeBlockLineDecorations,
  fenceClickGuard,
  fenceEnterKeymap,
  growFenceForInnerRun,
} from './code-blocks';
import {
  checkboxAutoFormat,
  headingLineDecorations,
  imagePreviewDecorations,
  linkClickHandler,
  modifierKeyClass,
  skipHiddenMarkdownKeymap,
} from './markdown-decorations';
import { codeLanguages, editorTheme, markdownHighlight } from './theme';

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

export function createDesktopEditorExtensions(): {
  standaloneExtensions: Extension[];
  collabBaseExtensions: Extension[];
} {
  const sharedExtensions: Extension[] = [
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
  ];

  return {
    standaloneExtensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap]), ...sharedExtensions],
    collabBaseExtensions: [keymap.of(defaultKeymap), ...sharedExtensions],
  };
}
