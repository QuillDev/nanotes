import type { TagStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Shared syntax colors for embedded fenced code blocks (```ts, ```python, …)
// used by both the desktop and web CodeMirror editors. Kept separate from
// preloaded language packages so the lazy web editor chunk stays small.
export const codeSyntaxHighlightSpecs: readonly TagStyle[] = [
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
];
