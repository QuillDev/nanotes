import React from 'react';
import type { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  CollabClient,
  NoteCollabSession,
  bytesToHex,
  hexToBytes,
  type CollabConnectionStatus,
} from '../collab';
import {
  DEFAULT_CLIENT_NAME,
  IS_TAURI,
  type NoteEntry,
  type NoteState,
  type PairingPollResult,
  type PairingStartResult,
  type SyncResult,
} from '../desktop/config';

export interface UseNoteSyncOptions {
  appConfigReady: boolean;
  state: NoteState;
  setState: React.Dispatch<React.SetStateAction<NoteState>>;
  stateRef: React.RefObject<NoteState>;
  editorViewRef: React.RefObject<EditorView | null>;
  collabCursorRef: React.RefObject<{ anchor: number; focus: boolean } | null>;
  setNotes: React.Dispatch<React.SetStateAction<NoteEntry[]>>;
  pinnedPaths: string[];
  setPinnedPaths: React.Dispatch<React.SetStateAction<string[]>>;
  pinnedPathsRef: React.RefObject<string[]>;
  syncUrl: string;
  syncToken: string;
  setSyncToken: React.Dispatch<React.SetStateAction<string>>;
  syncDeviceName: string;
  setSyncDeviceName: React.Dispatch<React.SetStateAction<string>>;
}

export function useNoteSync({
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
}: UseNoteSyncOptions) {
  const syncDeviceNameRef = React.useRef(syncDeviceName);
  syncDeviceNameRef.current = syncDeviceName;
  const lastServerDeviceNameRef = React.useRef<string | null>(null);
  const lastSentDeviceNameRef = React.useRef<string | null>(null);
  const deviceNameDirtyRef = React.useRef(false);

  const [syncStatus, setSyncStatus] = React.useState<'idle' | 'syncing' | 'error'>('idle');
  const [syncError, setSyncError] = React.useState<string | null>(null);
  const [collabStatus, setCollabStatus] = React.useState<CollabConnectionStatus>('disconnected');
  const [activeNoteId, setActiveNoteId] = React.useState<string | null>(null);
  const [liveSession, setLiveSession] = React.useState<NoteCollabSession | null>(null);
  const collabClientRef = React.useRef<CollabClient | null>(null);
  const liveSessionRef = React.useRef<NoteCollabSession | null>(null);
  liveSessionRef.current = liveSession;

  const [pairingStarting, setPairingStarting] = React.useState(false);
  const [pairingCode, setPairingCode] = React.useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  const pairingTimerRef = React.useRef<number | null>(null);
  const syncInFlightRef = React.useRef(false);

  const stopPairing = React.useCallback(() => {
    if (pairingTimerRef.current !== null) {
      window.clearInterval(pairingTimerRef.current);
      pairingTimerRef.current = null;
    }
    setPairingStarting(false);
    setPairingCode(null);
    setPairingUrl(null);
  }, []);

  const runSync = React.useCallback(async () => {
    if (!IS_TAURI || !syncUrl.trim() || !syncToken.trim() || syncInFlightRef.current) {
      return;
    }
    syncInFlightRef.current = true;
    setSyncStatus('syncing');
    setSyncError(null);
    try {
      const current = stateRef.current;
      const result = await invoke<SyncResult>('sync_now', {
        notesDir: current.notesDir,
        serverUrl: syncUrl.trim(),
        syncToken: syncToken.trim(),
        pinnedPaths: pinnedPathsRef.current,
        activeNotePath: current.notePath || null,
        liveNoteId: liveSessionRef.current?.ready ? liveSessionRef.current.noteId : null,
      });

      const prevPinned = [...pinnedPathsRef.current].sort().join('\0');
      const nextPinned = [...result.pinnedPaths].sort().join('\0');
      if (prevPinned !== nextPinned) {
        setPinnedPaths(result.pinnedPaths);
      }

      if (result.activeNoteId && stateRef.current.notePath === (result.activeNotePath ?? current.notePath)) {
        setActiveNoteId(prev => (prev === result.activeNoteId ? prev : (result.activeNoteId ?? null)));
      }

      if (result.activeNoteChanged && !liveSessionRef.current?.ready) {
        const latest = stateRef.current;
        const nextPath = result.activeNotePath || latest.notePath;
        if (latest.content === latest.savedContent && nextPath) {
          const refreshed = await invoke<string>('read_note', {
            notesDir: latest.notesDir,
            notePath: nextPath,
          }).catch(() => null);
          if (refreshed !== null) {
            setState(prev =>
              prev.content === prev.savedContent
                ? { ...prev, notePath: nextPath, content: refreshed, savedContent: refreshed }
                : prev,
            );
          }
        }
      }

      if (result.pulled > 0 || result.pushed > 0) {
        void invoke<NoteEntry[]>('list_notes', { notesDir: current.notesDir, query: '' })
          .then(entries => setNotes(entries))
          .catch(() => undefined);
      }

      setSyncStatus('idle');
    } catch (error: unknown) {
      setSyncError(error instanceof Error ? error.message : String(error));
      setSyncStatus('error');
    } finally {
      syncInFlightRef.current = false;
    }
  }, [pinnedPathsRef, setNotes, setPinnedPaths, setState, stateRef, syncToken, syncUrl]);

  const startSyncSignIn = React.useCallback(async () => {
    if (!IS_TAURI || pairingStarting) {
      return;
    }
    const serverUrl = syncUrl.trim();
    if (!serverUrl) {
      setSyncError('Enter a sync server URL first');
      setSyncStatus('error');
      return;
    }
    stopPairing();
    setPairingStarting(true);
    setSyncError(null);
    setSyncStatus('idle');
    try {
      const customName = syncDeviceNameRef.current.trim();
      const started = await invoke<PairingStartResult>('sync_start_pairing', {
        serverUrl,
        ...(customName ? { deviceName: customName } : {}),
      });
      setPairingStarting(false);
      setPairingCode(started.code);
      setPairingUrl(started.verificationUrl);
      void openUrl(started.verificationUrl).catch((error: unknown) => {
        setSyncError(`Could not open browser: ${error instanceof Error ? error.message : String(error)}`);
      });

      pairingTimerRef.current = window.setInterval(() => {
        void invoke<PairingPollResult>('sync_poll_pairing', {
          serverUrl,
          pollToken: started.pollToken,
        })
          .then(polled => {
            if (polled.status === 'approved' && polled.token) {
              stopPairing();
              setSyncToken(polled.token);
              setSyncError(null);
              setSyncStatus('idle');
            } else if (polled.status === 'expired') {
              stopPairing();
              setSyncError('Sign-in expired, try again');
              setSyncStatus('error');
            }
          })
          .catch(() => undefined);
      }, 2000);
    } catch (error: unknown) {
      setPairingStarting(false);
      setSyncError(error instanceof Error ? error.message : String(error));
      setSyncStatus('error');
    }
  }, [pairingStarting, setSyncToken, stopPairing, syncUrl]);

  React.useEffect(() => () => stopPairing(), [stopPairing]);

  React.useEffect(() => {
    if (!IS_TAURI || !appConfigReady || !syncUrl.trim() || !syncToken.trim()) {
      return;
    }
    void runSync();
    const interval = window.setInterval(() => {
      void runSync();
    }, 15_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [appConfigReady, runSync, syncToken, syncUrl]);

  React.useEffect(() => {
    if (!IS_TAURI || !appConfigReady || !syncUrl.trim() || !syncToken.trim()) {
      return;
    }
    // While a live Yjs room is active, WebSocket streams content edits in real time;
    // avoid firing redundant HTTP syncs on every local disk flush.
    if (liveSessionRef.current?.ready) {
      return;
    }
    // Brand-new local notes have no server ID yet: sync immediately once saved so
    // they join a live room without a 1.5s wait.
    const delay = !activeNoteId && state.notePath.trim() ? 0 : 800;
    const timer = window.setTimeout(() => {
      void runSync();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeNoteId, appConfigReady, runSync, state.notePath, state.savedContent, syncToken, syncUrl]);

  React.useEffect(() => {
    if (!IS_TAURI || !appConfigReady || !syncUrl.trim() || !syncToken.trim()) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runSync();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [appConfigReady, pinnedPaths, runSync, syncToken, syncUrl]);

  const commitDeviceName = React.useCallback(
    async (rawName: string) => {
      const serverUrl = syncUrl.trim();
      const token = syncToken.trim();
      if (!IS_TAURI || !serverUrl || !token) {
        return;
      }
      const nextName = rawName.trim().slice(0, 80) || DEFAULT_CLIENT_NAME;
      if (!deviceNameDirtyRef.current && nextName === lastServerDeviceNameRef.current) {
        return;
      }
      if (nextName === lastServerDeviceNameRef.current) {
        deviceNameDirtyRef.current = false;
        return;
      }
      try {
        lastSentDeviceNameRef.current = nextName;
        const saved = await invoke<string>('sync_rename_device', {
          serverUrl,
          syncToken: token,
          deviceName: nextName,
        });
        lastServerDeviceNameRef.current = saved;
        if ((syncDeviceNameRef.current.trim().slice(0, 80) || DEFAULT_CLIENT_NAME) === nextName) {
          deviceNameDirtyRef.current = false;
        }
      } catch (error: unknown) {
        setSyncError(error instanceof Error ? error.message : String(error));
      }
    },
    [syncToken, syncUrl],
  );

  React.useEffect(() => {
    if (!IS_TAURI || !appConfigReady || !syncUrl.trim() || !syncToken.trim() || !deviceNameDirtyRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      void commitDeviceName(syncDeviceName);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [appConfigReady, commitDeviceName, syncDeviceName, syncToken, syncUrl]);

  // Persistent WebSocket live-collab connection for real-time CRDT editing and instant note events.
  React.useEffect(() => {
    if (!IS_TAURI || !appConfigReady || !syncUrl.trim() || !syncToken.trim()) {
      collabClientRef.current?.close();
      collabClientRef.current = null;
      setLiveSession(null);
      setActiveNoteId(null);
      setCollabStatus('disconnected');
      lastServerDeviceNameRef.current = null;
      return;
    }

    let syncKickTimer: number | null = null;
    const kickSync = () => {
      if (syncKickTimer !== null) {
        window.clearTimeout(syncKickTimer);
      }
      syncKickTimer = window.setTimeout(() => {
        syncKickTimer = null;
        void runSync();
      }, 50);
    };

    const client = new CollabClient({
      serverUrl: syncUrl.trim(),
      token: syncToken.trim(),
      onStatus: status => setCollabStatus(status),
      onAuthed: serverName => {
        lastServerDeviceNameRef.current = serverName;
        if (deviceNameDirtyRef.current) {
          void commitDeviceName(syncDeviceNameRef.current);
          return;
        }
        if (serverName && !/^nanotes \(/i.test(serverName) && serverName !== syncDeviceNameRef.current.trim()) {
          setSyncDeviceName(serverName);
        }
      },
      onDeviceRenamed: serverName => {
        lastServerDeviceNameRef.current = serverName;
        const current = syncDeviceNameRef.current.trim().slice(0, 80) || DEFAULT_CLIENT_NAME;
        if (deviceNameDirtyRef.current && lastSentDeviceNameRef.current === serverName && current !== serverName) {
          return;
        }
        deviceNameDirtyRef.current = false;
        setSyncDeviceName(serverName);
      },
      onNoteChanged: event => {
        if (event.id !== liveSessionRef.current?.noteId || event.deletedAt !== null) {
          kickSync();
        }
      },
      onError: message => {
        if (message.toLowerCase().includes('token')) {
          setSyncError(message);
          setSyncStatus('error');
        }
      },
    });
    collabClientRef.current = client;

    return () => {
      if (syncKickTimer !== null) {
        window.clearTimeout(syncKickTimer);
      }
      client.close();
      if (collabClientRef.current === client) {
        collabClientRef.current = null;
      }
      setLiveSession(null);
      setCollabStatus('disconnected');
    };
  }, [appConfigReady, commitDeviceName, runSync, setSyncDeviceName, syncToken, syncUrl]);

  // Resolve the active note's server ID whenever the active file changes.
  const isLoadingNote = state.status === 'loading';
  React.useEffect(() => {
    if (!IS_TAURI || !appConfigReady || !syncUrl.trim() || !syncToken.trim()) {
      setActiveNoteId(null);
      return;
    }
    if (isLoadingNote || !state.notePath.trim()) {
      setActiveNoteId(null);
      return;
    }
    let cancelled = false;
    void invoke<string | null>('sync_note_id_for_path', {
      notesDir: state.notesDir,
      notePath: state.notePath,
    })
      .then(id => {
        if (!cancelled) {
          setActiveNoteId(id);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveNoteId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appConfigReady, isLoadingNote, state.notePath, state.notesDir, syncToken, syncUrl]);

  // Attach a live Yjs room for the active synced note and persist local CRDT state for offline merges.
  React.useEffect(() => {
    const client = collabClientRef.current;
    if (!IS_TAURI || !client || !activeNoteId) {
      setLiveSession(null);
      return;
    }

    let cancelled = false;
    let session: NoteCollabSession | null = null;
    const notesDir = stateRef.current.notesDir;
    const peerName = syncDeviceNameRef.current.trim() || DEFAULT_CLIENT_NAME;

    const attachReady = (readySession: NoteCollabSession) => {
      if (cancelled) return;
      const view = editorViewRef.current;
      collabCursorRef.current = view
        ? { anchor: view.state.selection.main.anchor, focus: view.hasFocus }
        : null;
      const mergedText = readySession.ytext.toString();
      setState(prev =>
        prev.content === mergedText ? prev : { ...prev, content: mergedText },
      );
      setLiveSession(readySession);
    };

    void invoke<string | null>('sync_read_yjs_state', { notesDir, noteId: activeNoteId })
      .catch(() => null)
      .then(savedHex => {
        if (cancelled || collabClientRef.current !== client) {
          return;
        }
        const savedBytes = savedHex ? hexToBytes(savedHex) : null;
        const snapshot = stateRef.current;
        session = client.openNote(activeNoteId, {
          savedYjsState: savedBytes,
          localContent: snapshot.content,
          getLatestLocalContent: () => stateRef.current.content,
          localDirty: snapshot.content !== snapshot.savedContent,
          peerName,
          onReady: () => {
            if (session) {
              attachReady(session);
            }
          },
          onPersist: (yjsState, content, rev, remotePath) => {
            void invoke('sync_write_yjs_state', {
              notesDir,
              noteId: activeNoteId,
              stateHex: bytesToHex(yjsState),
            }).catch(() => undefined);
            if (rev !== null && content === stateRef.current.savedContent) {
              const targetPath = stateRef.current.notePath || remotePath || '';
              if (targetPath) {
                void invoke('sync_mark_note_synced', {
                  notesDir,
                  noteId: activeNoteId,
                  path: targetPath,
                  rev,
                  content,
                }).catch(() => undefined);
              }
            }
          },
          onDeleted: () => {
            if (!cancelled) {
              setLiveSession(null);
              setActiveNoteId(null);
              void runSync();
            }
          },
        });
        if (session.ready) {
          attachReady(session);
        } else {
          setLiveSession(null);
        }
      });

    return () => {
      cancelled = true;
      session?.destroy();
      setLiveSession(prev => (prev === session ? null : prev));
    };
  }, [activeNoteId, collabCursorRef, editorViewRef, runSync, setState, stateRef, syncToken, syncUrl]);

  // Propagate device name edits to the live cursor label immediately without reconnecting.
  React.useEffect(() => {
    liveSession?.setPeerName(syncDeviceName.trim() || DEFAULT_CLIENT_NAME);
  }, [liveSession, syncDeviceName]);

  // Keep .nanotes-sync.json aligned whenever a live-edited note flushes to its local .md file.
  React.useEffect(() => {
    const session = liveSessionRef.current;
    if (!IS_TAURI || !session || !session.ready || session.rev === null || !state.notePath.trim()) {
      return;
    }
    void invoke('sync_mark_note_synced', {
      notesDir: state.notesDir,
      noteId: session.noteId,
      path: state.notePath,
      rev: session.rev,
      content: state.savedContent,
    }).catch(() => undefined);
  }, [state.notePath, state.notesDir, state.savedContent]);

  const clearLiveSession = React.useCallback(() => {
    const hadLiveSession = liveSessionRef.current !== null;
    setActiveNoteId(null);
    setLiveSession(null);
    return hadLiveSession;
  }, []);

  const handleDeviceNameChange = React.useCallback(
    (value: string) => {
      deviceNameDirtyRef.current = true;
      setSyncDeviceName(value);
    },
    [setSyncDeviceName],
  );

  const handleDeviceNameBlur = React.useCallback(
    (value: string) => {
      if (deviceNameDirtyRef.current) {
        void commitDeviceName(value);
      }
    },
    [commitDeviceName],
  );

  const signOutSync = React.useCallback(() => {
    stopPairing();
    setSyncToken('');
    lastServerDeviceNameRef.current = null;
    deviceNameDirtyRef.current = false;
    setSyncError(null);
    setSyncStatus('idle');
  }, [setSyncToken, stopPairing]);

  return {
    syncStatus,
    syncError,
    setSyncError,
    collabStatus,
    liveSession,
    pairingStarting,
    pairingCode,
    pairingUrl,
    runSync,
    startSyncSignIn,
    stopPairing,
    signOutSync,
    clearLiveSession,
    handleDeviceNameChange,
    handleDeviceNameBlur,
  };
}
