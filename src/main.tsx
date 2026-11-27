import React from 'react';
import { createRoot } from 'react-dom/client';
import CodeMirror from '@uiw/react-codemirror';
import type { EditorView } from '@codemirror/view';
import { Download, Menu, Plus, X } from 'lucide-react';
import { Button } from 'nakomponents';
import { SearchIsland } from './components/SearchIsland';
import { SettingsOverlay } from './components/SettingsOverlay';
import { IS_DESKTOP, invoke } from './desktop/bridge';
import {
  appShortcutLabel,
  browserPreviewConfig,
  DEFAULT_HOTKEY,
  DEFAULT_NOTE,
  DEFAULT_NOTES_DIR,
  defaultAppConfig,
  formatHotkey,
  glassBackground,
  hideOverlay,
  HOTKEY_MODIFIER_CODES,
  IS_ANDROID,
  IS_MAC,
  IS_WINDOWS,
  normalizeAppConfig,
  titleFromContent,
  writeBrowserPreviewConfig,
  type NoteEntry,
  type NoteState,
  type ShellStyle,
} from './desktop/config';
import { CollabEditor } from './editor/CollabEditor';
import { createDesktopEditorExtensions } from './editor/extensions';
import { useAppUpdater } from './hooks/useAppUpdater';
import { useDebouncedSave } from './hooks/useDebouncedSave';
import { useNoteSync } from './hooks/useNoteSync';
import './styles.css';

const SAMPLE_NOTE = `# NaNotes

Quick Markdown notes that stay in local files.

- Press \`${formatHotkey(DEFAULT_HOTKEY)}\` to toggle the overlay
- Type Markdown in one pane
- Markdown is styled while you edit

> Browser preview mode uses sample content. The desktop app reads and writes the configured notes folder.`;

function App() {
  const initialConfig = React.useMemo(() => (IS_DESKTOP ? defaultAppConfig() : browserPreviewConfig()), []);
  const [state, setState] = React.useState<NoteState>({
    notesDir: initialConfig.notesDir,
    notePath: initialConfig.notePath,
    content: '',
    savedContent: '',
    status: 'idle',
    message: 'Ready',
  });
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [hotkey, setHotkey] = React.useState<string>(initialConfig.hotkey);
  const [acceptedHotkey, setAcceptedHotkey] = React.useState<string>(initialConfig.hotkey);
  const [glassTint, setGlassTint] = React.useState(initialConfig.glassTint);
  const [glassOpacity, setGlassOpacity] = React.useState(initialConfig.glassOpacity);
  const [glassBlur, setGlassBlur] = React.useState(initialConfig.glassBlur);
  const [appearanceOpen, setAppearanceOpen] = React.useState(false);
  const [syncOpen, setSyncOpen] = React.useState(false);
  const [syncUrl, setSyncUrl] = React.useState(initialConfig.syncUrl);
  const [syncToken, setSyncToken] = React.useState(initialConfig.syncToken);
  const [syncDeviceName, setSyncDeviceName] = React.useState(initialConfig.syncDeviceName);
  const [recordingHotkey, setRecordingHotkey] = React.useState(false);
  const [launchAtLogin, setLaunchAtLogin] = React.useState(false);
  const [launchAtLoginReady, setLaunchAtLoginReady] = React.useState(!IS_DESKTOP);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [notes, setNotes] = React.useState<NoteEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [pinnedPaths, setPinnedPaths] = React.useState<string[]>(initialConfig.pinnedPaths);
  const [appConfigReady, setAppConfigReady] = React.useState(!IS_DESKTOP);

  const acceptedHotkeyRef = React.useRef(initialConfig.hotkey);
  const pinnedPathsRef = React.useRef<string[]>(initialConfig.pinnedPaths);
  pinnedPathsRef.current = pinnedPaths;
  const collabCursorRef = React.useRef<{ anchor: number; focus: boolean } | null>(null);

  // The live CodeMirror view, so commands like "new note" can move focus back to
  // the editor immediately instead of leaving it on whatever was last focused.
  const editorViewRef = React.useRef<EditorView | null>(null);
  // Always-current snapshot of state so the switch-note commands can flush the
  // outgoing note's pending edits without recreating their callbacks on every
  // keystroke (which would also keep re-subscribing the global key listener).
  const stateRef = React.useRef(state);
  stateRef.current = state;
  // Bumped on every note switch. In-flight saves capture the value at fire time
  // and drop their result if it changed, so a slow save from the previous note
  // never lands on (and appears to block) the note now in the editor.
  const noteGenRef = React.useRef(0);
  // The notes directory currently loaded into the editor. The settings field
  // commits on every blur, so this lets loadNote ignore commits that don't
  // actually change the folder (see loadNote).
  const loadedDirRef = React.useRef<string | null>(null);

  const shellStyle = React.useMemo<ShellStyle>(
    () => ({
      '--glass-bg': glassBackground(glassTint, glassOpacity),
      '--glass-blur': `${glassBlur}px`,
      '--glass-softness': String(glassBlur / 40),
    }),
    [glassBlur, glassOpacity, glassTint],
  );

  // Persist the note currently in the editor if it has unsaved changes. The
  // debounced autosave is cancelled the instant we switch notes, so without this
  // the last edits (within the debounce window) would be dropped. The outgoing
  // note is snapshotted synchronously, but the write is deferred to a macrotask
  // so switching notes paints first — the save never sits on the critical path.
  const flushPendingSave = React.useCallback(() => {
    const current = stateRef.current;
    if (!IS_DESKTOP || current.content === current.savedContent) {
      return;
    }
    window.setTimeout(() => {
      void invoke('write_note', {
        notesDir: current.notesDir,
        notePath: current.notePath,
        content: current.content,
      }).catch(() => undefined);
    }, 0);
  }, []);

  const focusEditor = React.useCallback(() => {
    // Defer to the next frame so the new document has been mounted before we
    // place the cursor and focus.
    requestAnimationFrame(() => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
  }, []);

  const { standaloneExtensions: extensions, collabBaseExtensions } = React.useMemo(
    () => createDesktopEditorExtensions(),
    [],
  );

  const updater = useAppUpdater(stateRef);
  const noteSync = useNoteSync({
    appConfigReady,
    state,
    setState,
    stateRef,
    editorViewRef,
    collabCursorRef,
    setNotes,
    pinnedPaths,
    setPinnedPaths,
    pinnedPathsRef,
    syncUrl,
    syncToken,
    setSyncToken,
    syncDeviceName,
    setSyncDeviceName,
  });

  const loadNote = React.useCallback(() => {
    // An empty/whitespace folder isn't a valid target; fall back to the default
    // and reflect it back into the field so it never sits blank.
    const notesDir = state.notesDir.trim() || DEFAULT_NOTES_DIR;
    // Nothing to reload if the folder hasn't actually changed since the last
    // load (e.g. blurring the settings field without editing it). Re-reading
    // would be wasted work and would clobber in-memory edits not yet flushed —
    // just normalise a blank/whitespace field back to the resolved value.
    if (loadedDirRef.current === notesDir) {
      if (notesDir !== state.notesDir) {
        setState(prev => ({ ...prev, notesDir }));
      }
      return;
    }
    loadedDirRef.current = notesDir;
    const gen = ++noteGenRef.current;
    setState(prev => ({ ...prev, notesDir, status: 'loading', message: 'Loading…' }));
    if (!IS_DESKTOP) {
      const content = window.localStorage.getItem('nanotes:browserPreviewContent') ?? SAMPLE_NOTE;
      setState(prev => ({
        ...prev,
        content,
        savedContent: content,
        status: 'saved',
        message: 'Browser preview',
      }));
      return;
    }
    void invoke('read_note', {
      notesDir,
      notePath: state.notePath,
    })
      .then(content => {
        if (noteGenRef.current !== gen) {
          return;
        }
        setState(prev => ({
          ...prev,
          content,
          savedContent: content,
          status: 'saved',
          message: 'Saved',
        }));
      })
      .catch((error: unknown) => {
        if (noteGenRef.current !== gen) {
          return;
        }
        // Forget the failed directory so committing again retries the load.
        loadedDirRef.current = null;
        setState(prev => ({
          ...prev,
          status: 'error',
          message: String(error),
        }));
      });
  }, [state.notePath, state.notesDir]);

  const openNote = React.useCallback((notePath: string) => {
    flushPendingSave();
    const gen = ++noteGenRef.current;
    setSearchOpen(false);
    setSearchQuery('');
    setSettingsOpen(false);
    setState(prev => ({ ...prev, notePath, status: 'loading', message: 'Loading…' }));

    if (!IS_DESKTOP) {
      // No filesystem to read from in browser preview; just settle the status.
      setState(prev => ({ ...prev, status: 'saved', message: 'Browser preview' }));
      focusEditor();
      return;
    }

    void invoke('read_note', {
      notesDir: stateRef.current.notesDir,
      notePath,
    })
      .then(content => {
        if (noteGenRef.current !== gen) {
          return;
        }
        setState(prev => ({ ...prev, notePath, content, savedContent: content, status: 'saved', message: 'Saved' }));
        focusEditor();
      })
      .catch((error: unknown) => {
        if (noteGenRef.current !== gen) {
          return;
        }
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [flushPendingSave, focusEditor]);

  const { clearLiveSession } = noteSync;
  const createNewNote = React.useCallback(() => {
    flushPendingSave();
    noteGenRef.current += 1;
    const hadLiveSession = clearLiveSession();
    setSearchOpen(false);
    setSettingsOpen(false);
    // Clear the editor imperatively so the new note appears the same frame,
    // independent of React re-rendering and the controlled-value sync (which
    // stalls when keystrokes/renders from rapid typing are still in flight —
    // that was the lag when creating a note right after typing).
    // Never clear a live CollabEditor view in place: yCollab is still attached
    // until React unmounts it, so clearing it would broadcast a wipe over Yjs.
    const view = editorViewRef.current;
    if (view && !hadLiveSession) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
      view.focus();
    }
    // Purely in-memory: no IPC, no file written. The empty notePath marks an
    // unsaved new note; the file is created (with a unique name picked by
    // write_note) only once the user types and the autosave fires.
    setState(prev => ({ ...prev, notePath: '', content: '', savedContent: '', status: 'saved', message: 'New note' }));

    if (!IS_DESKTOP) {
      window.localStorage.setItem('nanotes:browserPreviewContent', '');
    }
  }, [clearLiveSession, flushPendingSave]);

  const openSearch = React.useCallback(() => {
    setSearchOpen(true);
    setSettingsOpen(false);
    setSearchQuery('');

    // The desktop note list is fetched by the searchOpen/searchQuery effect below;
    // here we only seed the browser-preview list, which that effect skips.
    if (!IS_DESKTOP) {
      setNotes([{ path: DEFAULT_NOTE, title: 'NaNotes', modifiedMs: 0 }]);
    }
  }, []);

  const togglePin = React.useCallback((notePath: string) => {
    setPinnedPaths(prev => {
      return prev.includes(notePath) ? prev.filter(path => path !== notePath) : [...prev, notePath];
    });
  }, []);

  const deleteNote = React.useCallback((notePath: string) => {
    setPinnedPaths(prev => {
      return prev.filter(path => path !== notePath);
    });

    if (!IS_DESKTOP) {
      setNotes(prev => prev.filter(note => note.path !== notePath));
      return;
    }

    void invoke('delete_note', { notesDir: state.notesDir, notePath })
      .then(() => invoke('list_notes', { notesDir: state.notesDir, query: searchQuery }))
      .then(setNotes)
      .catch((error: unknown) => {
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [searchQuery, state.notesDir]);

  const toggleLaunchAtLogin = React.useCallback(() => {
    if (!IS_DESKTOP || !launchAtLoginReady) {
      return;
    }

    const next = !launchAtLogin;
    setLaunchAtLogin(next);
    setState(prev => ({ ...prev, status: 'saving', message: next ? 'Enabling login launch…' : 'Disabling login launch…' }));
    void invoke('autostart_set', { enabled: next })
      .then(() => {
        setState(prev => ({ ...prev, status: 'saved', message: next ? 'Launch at login enabled' : 'Launch at login disabled' }));
      })
      .catch((error: unknown) => {
        setLaunchAtLogin(!next);
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [launchAtLogin, launchAtLoginReady]);

  // Register the chosen hotkey with the backend whenever it changes. Native
  // persistence is handled by the app-config effect below.
  const hotkeyAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (!IS_DESKTOP) {
      acceptedHotkeyRef.current = hotkey;
      setAcceptedHotkey(hotkey);
      return;
    }
    const isInitial = !hotkeyAppliedRef.current;
    hotkeyAppliedRef.current = true;
    void invoke('set_hotkey', { accelerator: hotkey })
      .then(() => {
        acceptedHotkeyRef.current = hotkey;
        setAcceptedHotkey(hotkey);
        if (!isInitial) {
          setState(prev => ({ ...prev, status: 'saved', message: `Hotkey set to ${formatHotkey(hotkey)}` }));
        }
      })
      .catch((error: unknown) => {
        setHotkey(acceptedHotkeyRef.current);
        setState(prev => ({ ...prev, status: 'error', message: `Hotkey: ${String(error)}` }));
      });
  }, [hotkey]);

  // Latest hotkey, readable from the recording effect's cleanup without making
  // the effect depend on (and thus restart on) every hotkey change.
  const hotkeyRef = React.useRef(hotkey);
  hotkeyRef.current = hotkey;

  // While recording, listen for the next combo on the window in the capture
  // phase so it lands regardless of focus and beats CodeMirror / global key
  // handlers (which would otherwise eat the press). The live OS shortcut is
  // suspended for the duration so pressing the current hotkey gets recorded
  // instead of toggling the overlay; it's re-armed when recording ends.
  React.useEffect(() => {
    if (!recordingHotkey) {
      return;
    }
    if (IS_DESKTOP) {
      void invoke('clear_hotkey').catch(() => undefined);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        setRecordingHotkey(false);
        return;
      }
      // Ignore lone modifier presses — keep listening until a real key arrives.
      if (HOTKEY_MODIFIER_CODES.has(event.code)) {
        return;
      }
      const modifiers: string[] = [];
      if (event.metaKey) modifiers.push('super');
      if (event.ctrlKey) modifiers.push('control');
      if (event.altKey) modifiers.push('alt');
      if (event.shiftKey) modifiers.push('shift');
      if (modifiers.length === 0) {
        setState(prev => ({ ...prev, status: 'error', message: 'Hotkey needs a modifier (⌘, ⌥, ⌃, or ⇧)' }));
        return;
      }
      setHotkey([...modifiers, event.code].join('+'));
      setRecordingHotkey(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      // Re-arm the shortcut. If a new combo was captured, the hotkey effect
      // re-registers it right after this cleanup, making this a harmless no-op.
      if (IS_DESKTOP) {
        void invoke('set_hotkey', { accelerator: hotkeyRef.current }).catch(() => undefined);
      }
    };
  }, [recordingHotkey]);

  React.useEffect(() => {
    if (!IS_DESKTOP) {
      return;
    }

    let cancelled = false;
    void invoke('read_app_config')
      .then(config => {
        if (cancelled) {
          return;
        }
        const next = normalizeAppConfig(config);
        setState(prev => ({ ...prev, notesDir: next.notesDir, notePath: next.notePath }));
        setHotkey(next.hotkey);
        acceptedHotkeyRef.current = next.hotkey;
        setAcceptedHotkey(next.hotkey);
        setPinnedPaths(next.pinnedPaths);
        pinnedPathsRef.current = next.pinnedPaths;
        setGlassTint(next.glassTint);
        setGlassOpacity(next.glassOpacity);
        setGlassBlur(next.glassBlur);
        setSyncUrl(next.syncUrl);
        setSyncToken(next.syncToken);
        setSyncDeviceName(next.syncDeviceName);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState(prev => ({ ...prev, status: 'error', message: `Settings: ${String(error)}` }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAppConfigReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!appConfigReady) {
      return;
    }
    const config = normalizeAppConfig({
      notesDir: state.notesDir,
      notePath: state.notePath || DEFAULT_NOTE,
      hotkey: acceptedHotkey,
      pinnedPaths,
      glassTint,
      glassOpacity,
      glassBlur,
      syncUrl,
      syncToken,
      syncDeviceName,
    });
    if (!IS_DESKTOP) {
      writeBrowserPreviewConfig(config);
      return;
    }
    void invoke('write_app_config', { config }).catch((error: unknown) => {
      setState(prev => ({ ...prev, status: 'error', message: `Settings: ${String(error)}` }));
    });
  }, [acceptedHotkey, appConfigReady, glassBlur, glassOpacity, glassTint, pinnedPaths, state.notePath, state.notesDir, syncDeviceName, syncToken, syncUrl]);

  // Load the initial note once settings have loaded. Subsequent folder/note
  // changes are driven explicitly by loadNote/openNote/createNewNote.
  React.useEffect(() => {
    if (!appConfigReady) {
      return;
    }
    loadNote();
  }, [appConfigReady]);

  React.useEffect(() => {
    if (!IS_DESKTOP) {
      return;
    }

    void invoke('autostart_is_enabled')
      .then(enabled => {
        setLaunchAtLogin(enabled);
        setLaunchAtLoginReady(true);
      })
      .catch(() => {
        setLaunchAtLoginReady(true);
      });
  }, []);

  React.useEffect(() => {
    if (!searchOpen || !IS_DESKTOP) {
      return;
    }

    void invoke('list_notes', { notesDir: state.notesDir, query: searchQuery })
      .then(setNotes)
      .catch((error: unknown) => {
        setState(prev => ({ ...prev, status: 'error', message: String(error) }));
      });
  }, [searchOpen, searchQuery, state.notesDir]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isAppShortcut = IS_MAC
        ? event.metaKey && !event.ctrlKey && !event.altKey
        : event.ctrlKey && !event.metaKey && !event.altKey;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        void hideOverlay();
        return;
      }

      if (!isAppShortcut) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        setSearchOpen(false);
        setSettingsOpen(value => !value);
      } else if (key === 'n') {
        event.preventDefault();
        createNewNote();
      } else if (key === 'p') {
        event.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
        } else {
          openSearch();
        }
      } else if (key === 'q') {
        event.preventDefault();
        void hideOverlay();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [createNewNote, openSearch, searchOpen, settingsOpen]);

  useDebouncedSave(state, setState, noteGenRef, Boolean(syncUrl.trim() && syncToken.trim()));

  const pinnedPathSet = React.useMemo(() => new Set(pinnedPaths), [pinnedPaths]);

  const filteredNotes = React.useMemo(() => {
    const ordered = [...notes].sort((a, b) => Number(pinnedPathSet.has(b.path)) - Number(pinnedPathSet.has(a.path)));
    return ordered.slice(0, 10);
  }, [notes, pinnedPathSet]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [filteredNotes, searchOpen]);

  return (
    <main className="shell" style={shellStyle}>
      <header className="topbar" data-drag-region>
        <SearchIsland
          searchOpen={searchOpen}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          noteTitle={titleFromContent(state.content)}
          filteredNotes={filteredNotes}
          pinnedPathSet={pinnedPathSet}
          selectedIndex={selectedIndex}
          onSelectedIndexChange={setSelectedIndex}
          onOpenSearch={openSearch}
          onOpenNote={openNote}
          onTogglePin={togglePin}
          onDeleteNote={deleteNote}
        />
        <div className="topbarActions">
          {updater.updateState === 'available' && updater.availableVersion ? (
            <Button
              className="topbarButton topbarButton-update"
              size="icon-xs"
              variant="ghost"
              type="button"
              aria-label={`Update available (${updater.availableVersion})`}
              title={`Update to v${updater.availableVersion}`}
              onClick={() => setSettingsOpen(true)}
            >
              <Download />
            </Button>
          ) : null}
          <Button
            className="topbarButton"
            size="icon-xs"
            variant="ghost"
            type="button"
            aria-label="New note"
            title={`New note (${appShortcutLabel('N')})`}
            onClick={createNewNote}
          >
            <Plus />
          </Button>
          {IS_ANDROID ? (
            <Button
              className="topbarButton"
              size="icon-xs"
              variant="ghost"
              type="button"
              aria-label="Settings"
              onClick={() => setSettingsOpen(value => !value)}
            >
              <Menu />
            </Button>
          ) : null}
          {IS_WINDOWS ? (
            <Button
              className="topbarButton"
              size="icon-xs"
              variant="ghost"
              type="button"
              aria-label="Hide overlay"
              title={`Hide overlay (${appShortcutLabel('Q')})`}
              onClick={() => {
                void hideOverlay();
              }}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </header>

      {settingsOpen ? (
        <SettingsOverlay
          notesDir={state.notesDir}
          onNotesDirChange={notesDir => setState(prev => ({ ...prev, notesDir }))}
          onCommitNotesDir={loadNote}
          hotkey={hotkey}
          recordingHotkey={recordingHotkey}
          onToggleRecordHotkey={() => setRecordingHotkey(recording => !recording)}
          onStopRecordHotkey={() => setRecordingHotkey(false)}
          appearanceOpen={appearanceOpen}
          onAppearanceOpenChange={setAppearanceOpen}
          glassTint={glassTint}
          onGlassTintChange={setGlassTint}
          glassOpacity={glassOpacity}
          onGlassOpacityChange={setGlassOpacity}
          glassBlur={glassBlur}
          onGlassBlurChange={setGlassBlur}
          syncOpen={syncOpen}
          onSyncOpenChange={setSyncOpen}
          syncUrl={syncUrl}
          onSyncUrlChange={setSyncUrl}
          syncToken={syncToken}
          syncDeviceName={syncDeviceName}
          onSyncDeviceNameChange={noteSync.handleDeviceNameChange}
          onSyncDeviceNameBlur={noteSync.handleDeviceNameBlur}
          collabStatus={noteSync.collabStatus}
          syncStatus={noteSync.syncStatus}
          syncError={noteSync.syncError}
          onSyncError={noteSync.setSyncError}
          pairingStarting={noteSync.pairingStarting}
          pairingCode={noteSync.pairingCode}
          pairingUrl={noteSync.pairingUrl}
          onStartSyncSignIn={() => {
            void noteSync.startSyncSignIn();
          }}
          onStopPairing={noteSync.stopPairing}
          onRunSync={() => {
            void noteSync.runSync();
          }}
          onSignOutSync={noteSync.signOutSync}
          launchAtLogin={launchAtLogin}
          launchAtLoginReady={launchAtLoginReady}
          onToggleLaunchAtLogin={toggleLaunchAtLogin}
          appVersion={updater.appVersion}
          supportsInAppUpdater={updater.supportsInAppUpdater}
          updateState={updater.updateState}
          availableVersion={updater.availableVersion}
          downloadProgress={updater.downloadProgress}
          updateError={updater.updateError}
          onCheckForUpdates={() => {
            void updater.checkForUpdates(true);
          }}
          onInstallUpdate={() => {
            void updater.installUpdate();
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      <section className={settingsOpen ? 'editorShell editorShell-hidden' : 'editorShell'}>
        {noteSync.liveSession ? (
          <CollabEditor
            key={noteSync.liveSession.noteId}
            session={noteSync.liveSession}
            baseExtensions={collabBaseExtensions}
            initialAnchorRef={collabCursorRef}
            onCreateEditor={view => {
              editorViewRef.current = view;
            }}
            onChange={value => setState(prev => ({ ...prev, content: value }))}
          />
        ) : (
          <CodeMirror
            autoFocus
            basicSetup={false}
            extensions={extensions}
            height="100%"
            placeholder="Start typing…"
            theme="dark"
            value={state.content}
            onCreateEditor={view => {
              editorViewRef.current = view;
            }}
            onChange={value => setState(prev => ({ ...prev, content: value }))}
          />
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
