import React from 'react';
import type { AvailableUpdate } from '../../shared/ipc';
import { IS_DESKTOP, invoke, onUpdateProgress } from '../desktop/bridge';
import { IS_MAC, IS_WINDOWS, type NoteState } from '../desktop/config';

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'error';

export function useAppUpdater(stateRef: React.RefObject<NoteState>) {
  const [appVersion, setAppVersion] = React.useState<string | null>(null);
  const [updateState, setUpdateState] = React.useState<UpdateState>('idle');
  const [availableVersion, setAvailableVersion] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState<number | null>(null);
  const [updateError, setUpdateError] = React.useState<string | null>(null);

  const availableUpdateRef = React.useRef<AvailableUpdate | null>(null);
  const lastUpdateCheckAtRef = React.useRef(0);

  const supportsInAppUpdater = IS_DESKTOP && (IS_MAC || IS_WINDOWS);

  const replaceAvailableUpdate = React.useCallback((next: AvailableUpdate | null) => {
    const previous = availableUpdateRef.current;
    availableUpdateRef.current = next;
    if (previous && previous.rid !== next?.rid) {
      void invoke('update_close', { rid: previous.rid }).catch(() => undefined);
    }
  }, []);

  const checkForUpdates = React.useCallback(
    async (manual: boolean) => {
      if (!supportsInAppUpdater) {
        if (manual && IS_DESKTOP) {
          void invoke('open_url', { url: 'https://github.com/QuillDev/nanotes/releases/latest' }).catch(() => undefined);
        }
        return;
      }

      lastUpdateCheckAtRef.current = Date.now();
      if (manual) {
        setUpdateState('checking');
        setUpdateError(null);
      }

      try {
        const update = await invoke('update_check');
        if (update) {
          replaceAvailableUpdate(update);
          setAvailableVersion(update.version);
          setUpdateError(null);
          setUpdateState('available');
        } else {
          replaceAvailableUpdate(null);
          setAvailableVersion(null);
          setUpdateError(null);
          if (manual) {
            setUpdateState('up-to-date');
          }
        }
      } catch (error: unknown) {
        if (manual) {
          setUpdateError(error instanceof Error ? error.message : String(error));
          setUpdateState('error');
        }
      }
    },
    [replaceAvailableUpdate, supportsInAppUpdater],
  );

  const installUpdate = React.useCallback(async () => {
    const update = availableUpdateRef.current;
    if (!supportsInAppUpdater || !update) {
      return;
    }

    setUpdateState('downloading');
    setDownloadProgress(null);
    setUpdateError(null);

    let downloaded = 0;
    let total = 0;
    const stopProgress = onUpdateProgress(progress => {
      if (progress.event === 'Started') {
        total = progress.data.contentLength ?? 0;
        setDownloadProgress(total > 0 ? 0 : null);
      } else if (progress.event === 'Progress') {
        downloaded += progress.data.chunkLength;
        if (total > 0) {
          setDownloadProgress(Math.min(100, Math.round((downloaded / total) * 100)));
        }
      } else {
        setDownloadProgress(100);
      }
    });

    try {
      const current = stateRef.current;
      if (current.content !== current.savedContent) {
        await invoke('write_note', {
          notesDir: current.notesDir,
          notePath: current.notePath,
          content: current.content,
        }).catch(() => undefined);
      }

      await invoke('update_install', { rid: update.rid });
      replaceAvailableUpdate(null);
      await invoke('relaunch');
    } catch (error: unknown) {
      setUpdateError(error instanceof Error ? error.message : String(error));
      setUpdateState('error');
    } finally {
      stopProgress();
    }
  }, [replaceAvailableUpdate, stateRef, supportsInAppUpdater]);

  React.useEffect(() => {
    if (!IS_DESKTOP) {
      return;
    }

    let cancelled = false;
    void invoke('app_version')
      .then(version => {
        if (!cancelled) {
          setAppVersion(version);
        }
      })
      .catch(() => undefined);

    const timer = supportsInAppUpdater
      ? window.setTimeout(() => {
          if (!cancelled) {
            void checkForUpdates(false);
          }
        }, 3000)
      : null;

    const onVisibilityChange = () => {
      if (
        !supportsInAppUpdater ||
        cancelled ||
        document.visibilityState !== 'visible' ||
        Date.now() - lastUpdateCheckAtRef.current < 30 * 60 * 1000
      ) {
        return;
      }
      void checkForUpdates(false);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      replaceAvailableUpdate(null);
    };
  }, [checkForUpdates, replaceAvailableUpdate, supportsInAppUpdater]);

  return {
    appVersion,
    supportsInAppUpdater,
    updateState,
    availableVersion,
    downloadProgress,
    updateError,
    checkForUpdates,
    installUpdate,
  };
}
