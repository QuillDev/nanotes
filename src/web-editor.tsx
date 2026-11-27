import React from "react";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension, Text } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { NoteCollabSession } from "./collab";
import { CollabEditor } from "./editor/CollabEditor";
import { codeSyntaxHighlightSpecs } from "./editor/highlight";

const webHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: "#ffffff", fontSize: "1.45em", fontWeight: "700" },
  { tag: tags.heading2, color: "#f6f7fb", fontSize: "1.25em", fontWeight: "700" },
  { tag: tags.heading3, color: "#eceef5", fontSize: "1.1em", fontWeight: "650" },
  { tag: tags.strong, color: "#ffffff", fontWeight: "700" },
  { tag: tags.emphasis, color: "#f8b4cb", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "#8b91a7", textDecoration: "line-through" },
  { tag: tags.monospace, color: "#ff9fc0", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { tag: tags.link, color: "#ff7aa5", textDecoration: "underline" },
  { tag: tags.url, color: "#ff7aa5" },
  { tag: tags.quote, color: "#b5bbcf", fontStyle: "italic" },
  { tag: tags.meta, color: "#686e85" },
  { tag: tags.processingInstruction, color: "#686e85" },
  ...codeSyntaxHighlightSpecs,
]);

const webEditorTheme = EditorView.theme(
  {
    "&": {
      color: "#eceef5",
      fontSize: "15px",
      lineHeight: "1.65",
      height: "100%",
    },
    ".cm-content": {
      caretColor: "#f65c8e",
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      minHeight: "100%",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#f65c8e",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgba(246, 92, 142, 0.28) !important",
    },
    ".cm-placeholder": {
      color: "#686e85",
    },
  },
  { dark: true },
);

function titleFromDoc(doc: Text): string {
  for (let i = 1; i <= doc.lines; i += 1) {
    const cleaned = doc.line(i).text.trim().replace(/^#+\s*/, "").trim();
    if (cleaned) return cleaned.slice(0, 120);
  }
  return "Untitled";
}

export default function LiveNoteEditor({
  session,
  onTitleChange,
}: {
  session: NoteCollabSession;
  onTitleChange?: (title: string) => void;
}) {
  const onTitleChangeRef = React.useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const lastTitleRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    lastTitleRef.current = null;
  }, [session]);

  const baseExtensions = React.useMemo<Extension[]>(
    () => [
      drawSelection(),
      keymap.of(defaultKeymap),
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(webHighlight),
      EditorView.lineWrapping,
      webEditorTheme,
      EditorView.updateListener.of((vu) => {
        if (lastTitleRef.current === null) {
          lastTitleRef.current = titleFromDoc(vu.startState.doc);
        }
        if (vu.docChanged) {
          const nextTitle = titleFromDoc(vu.state.doc);
          if (nextTitle !== lastTitleRef.current) {
            lastTitleRef.current = nextTitle;
            onTitleChangeRef.current?.(nextTitle);
          }
        }
      }),
    ],
    [],
  );

  return <CollabEditor className="editorHost" session={session} baseExtensions={baseExtensions} />;
}
