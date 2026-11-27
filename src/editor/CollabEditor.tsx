import React from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { NoteCollabSession } from '../collab';

export function CollabEditor({
  session,
  baseExtensions,
  className,
  style,
  initialAnchorRef,
  onCreateEditor,
  onChange,
}: {
  session: NoteCollabSession;
  baseExtensions: Extension[];
  className?: string;
  style?: React.CSSProperties;
  initialAnchorRef?: React.RefObject<{ anchor: number; focus: boolean } | null>;
  onCreateEditor?: (view: EditorView) => void;
  onChange?: (value: string) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const onCreateRef = React.useRef(onCreateEditor);
  onCreateRef.current = onCreateEditor;
  const trackChange = onChange !== undefined;

  React.useLayoutEffect(() => {
    const parent = containerRef.current;
    if (!parent) {
      return;
    }

    const docText = session.ytext.toString();
    const pendingCursor = initialAnchorRef?.current ?? null;
    if (initialAnchorRef) {
      initialAnchorRef.current = null;
    }
    const anchor = pendingCursor ? Math.min(pendingCursor.anchor, docText.length) : undefined;

    const extensions: Extension[] = [
      cmPlaceholder('Start typing…'),
      ...baseExtensions,
      yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
      keymap.of(yUndoManagerKeymap),
    ];
    if (!className) {
      extensions.unshift(
        EditorView.theme({
          '&': { height: '100%' },
          '& .cm-scroller': { height: '100% !important' },
        }),
      );
    }
    if (trackChange) {
      extensions.push(
        EditorView.updateListener.of(vu => {
          if (vu.docChanged) {
            onChangeRef.current?.(vu.state.doc.toString());
          }
        }),
      );
    }

    const state = EditorState.create({
      doc: docText,
      ...(anchor !== undefined ? { selection: { anchor } } : {}),
      extensions,
    });

    const view = new EditorView({ state, parent });
    onCreateRef.current?.(view);
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
  }, [baseExtensions, className, initialAnchorRef, session, trackChange]);

  return (
    <div
      className={className}
      style={style ?? (className ? undefined : { height: '100%', width: '100%' })}
      ref={containerRef}
    />
  );
}
