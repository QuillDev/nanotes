import React from 'react';
import { IS_DESKTOP, invoke } from '../desktop/bridge';
import { SAVE_DELAY_MS, type NoteState } from '../desktop/config';

export function useDebouncedSave(
  state: NoteState,
  setState: React.Dispatch<React.SetStateAction<NoteState>>,
  noteGenRef: React.RefObject<number>,
  fastNewNoteSave: boolean,
) {
  React.useEffect(() => {
    if (state.status === 'loading' || state.content === state.savedContent) {
      return;
    }

    const delay = fastNewNoteSave && !state.notePath.trim() ? 150 : SAVE_DELAY_MS;
    const handle = window.setTimeout(() => {
      // Stamp the active note; if it changes (new note / opened another) before
      // this async save resolves, its result must not be applied to whatever note
      // is now in the editor.
      const gen = noteGenRef.current;
      setState(prev => ({ ...prev, status: 'saving', message: 'Saving…' }));
      if (!IS_DESKTOP) {
        window.localStorage.setItem('nanotes:browserPreviewContent', state.content);
        setState(prev => ({ ...prev, savedContent: prev.content, status: 'saved', message: 'Preview saved' }));
        return;
      }
      void invoke('write_note', {
        notesDir: state.notesDir,
        notePath: state.notePath,
        content: state.content,
      })
        .then(result => {
          if (noteGenRef.current !== gen) {
            return;
          }
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
    }, delay);

    return () => window.clearTimeout(handle);
  }, [state.content, state.notePath, state.savedContent, state.status, state.notesDir, setState, noteGenRef, fastNewNoteSave]);
}
