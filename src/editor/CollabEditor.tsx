import React from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { NoteCollabSession } from '../collab';

export function CollabEditor({
  session,
  baseExtensions,
  initialAnchorRef,
  onCreateEditor,
  onChange,
}: {
  session: NoteCollabSession;
  baseExtensions: Extension[];
  initialAnchorRef: React.RefObject<{ anchor: number; focus: boolean } | null>;
  onCreateEditor: (view: EditorView) => void;
  onChange: (value: string) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const onCreateRef = React.useRef(onCreateEditor);
  onCreateRef.current = onCreateEditor;

  React.useLayoutEffect(() => {
    const parent = containerRef.current;
    if (!parent) {
      return;
    }

    const docText = session.ytext.toString();
    const pendingCursor = initialAnchorRef.current;
    initialAnchorRef.current = null;
    const anchor = pendingCursor ? Math.min(pendingCursor.anchor, docText.length) : undefined;

    const state = EditorState.create({
      doc: docText,
      ...(anchor !== undefined ? { selection: { anchor } } : {}),
      extensions: [
        cmPlaceholder('Start typing…'),
        EditorView.theme({
          '&': { height: '100%' },
          '& .cm-scroller': { height: '100% !important' },
        }),
        EditorView.updateListener.of(vu => {
          if (vu.docChanged) {
            onChangeRef.current(vu.state.doc.toString());
          }
        }),
        ...baseExtensions,
        yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
        keymap.of(yUndoManagerKeymap),
      ],
    });

    const view = new EditorView({ state, parent });
    onCreateRef.current(view);
    if (pendingCursor?.focus) {
      view.focus();
    }
    // y-codemirror.next starts with empty remote selection decorations until the
    // first view update; nudge the view so peers already in the room appear at once.
    const raf = requestAnimationFrame(() => {
      if (session.awareness.getStates().size > 1) {
        view.dispatch({});
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      view.destroy();
    };
  }, [baseExtensions, initialAnchorRef, session]);

  return <div style={{ height: '100%', width: '100%' }} ref={containerRef} />;
}
