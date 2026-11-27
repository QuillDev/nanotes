import React from 'react';
import { appShortcutLabel, type NoteEntry } from '../desktop/config';
import { useMorphHeight } from '../morph';
import { Pin, Trash2 } from 'lucide-react';
import { Button } from 'nakomponents';

export interface SearchIslandProps {
  searchOpen: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  noteTitle: string;
  filteredNotes: NoteEntry[];
  pinnedPathSet: Set<string>;
  selectedIndex: number;
  onSelectedIndexChange: React.Dispatch<React.SetStateAction<number>>;
  onOpenSearch: () => void;
  onOpenNote: (path: string) => void;
  onTogglePin: (path: string) => void;
  onDeleteNote: (path: string) => void;
}

export function SearchIsland({
  searchOpen,
  searchQuery,
  onSearchQueryChange,
  noteTitle,
  filteredNotes,
  pinnedPathSet,
  selectedIndex,
  onSelectedIndexChange,
  onOpenSearch,
  onOpenNote,
  onTogglePin,
  onDeleteNote,
}: SearchIslandProps) {
  // The search "island" morphs from a pill into a panel that grows downward over
  // the editor (Dynamic-Island style), via the shared morph animation. The hook
  // measures the open content height and feeds it back as the inline height so
  // CSS can transition the grow/shrink — on open/close and as results change. At
  // rest the height is left unset so the CSS pill height shows through.
  const { ref: islandRef, height: islandHeight } = useMorphHeight<HTMLDivElement>(searchOpen, [filteredNotes]);

  return (
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
            onChange={event => onSearchQueryChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                onSelectedIndexChange(index => Math.min(index + 1, filteredNotes.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                onSelectedIndexChange(index => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const note = filteredNotes[selectedIndex];
                if (note) {
                  onOpenNote(note.path);
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
          onClick={onOpenSearch}
        >
          <svg className="topbarSearchIcon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <span className="topbarSearchLabel">{noteTitle}</span>
        </button>
      )}
      {searchOpen ? (
        <div className="islandResults">
          <div className="noteResults morphScroll">
            {filteredNotes.map((note, index) => {
              const pinned = pinnedPathSet.has(note.path);
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
                  onMouseMove={() => onSelectedIndexChange(index)}
                  onClick={() => onOpenNote(note.path)}
                >
                  <span className="noteResultTitle">{note.title}</span>
                  <span className="noteResultActions">
                    <Button
                      aria-label={pinned ? 'Unpin note' : 'Pin note'}
                      aria-pressed={pinned}
                      className="noteResultAction noteResultAction-pin"
                      size="icon-xs"
                      variant="ghost"
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        onTogglePin(note.path);
                      }}
                    >
                      <Pin fill={pinned ? 'currentColor' : 'none'} />
                    </Button>
                    <Button
                      aria-label="Delete note"
                      className="noteResultAction noteResultAction-delete"
                      size="icon-xs"
                      variant="ghost"
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        onDeleteNote(note.path);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </div>
              );
            })}
            {filteredNotes.length === 0 ? <div className="emptyResults">No notes found</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
