import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { HighlightStyle, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { codeSyntaxHighlightSpecs } from './highlight';

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

export const codeLanguages = [...preloadedCodeLanguages, ...languages];

export const markdownHighlight = HighlightStyle.define([
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
  ...codeSyntaxHighlightSpecs,
]);

export const editorTheme = EditorView.theme({
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
