import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { IS_TAURI, type PathSuggestion } from '../desktop/config';
import { PathGlyph } from './Icons';

// A text input that offers filesystem path completions while the value looks
// like a path (starts with `/`, `./`, `../`, or `~/`). Suggestions come from
// the `suggest_paths` Tauri command; outside Tauri it degrades to a plain input.
export function PathInput({
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
