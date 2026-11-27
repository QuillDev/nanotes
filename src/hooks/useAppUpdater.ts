import React from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { relaunch } from '@tauri-apps/plugin-process';
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';
import {
  IS_ANDROID,
  IS_MAC,
  IS_TAURI,
  IS_WINDOWS,
  type AndroidUpdateCandidate,
  type AndroidUpdaterEvent,
  type NoteSaveResult,
  type NoteState,
} from '../desktop/config';

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'error';

export function useAppUpdater(stateRef: React.RefObject<NoteState>) {
  const [appVersion, setAppVersion] = React.useState<string | null>(null);
  const [updateState, setUpdateState] = React.useState<UpdateState>('idle');
  const [availableVersion, setAvailableVersion] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState<number | null>(null);
  const [updateError, setUpdateError] = React.useState<string | null>(null);

  const availableUpdateRef = React.useRef<Update | null>(null);
  const androidUpdateRef = React.useRef<AndroidUpdateCandidate | null>(null);
  const androidCheckWaitersRef = React.useRef<
    Map<string, (event: Extract<AndroidUpdaterEvent, { type: 'check' }>) => void>
  >(new Map());
  const lastUpdateCheckAtRef = React.useRef(0);

  const hasAndroidUpdater = IS_TAURI && IS_ANDROID && Boolean(window.NanotesAndroidUpdater);
  const supportsInAppUpdater = IS_TAURI && (IS_MAC || IS_WINDOWS || hasAndroidUpdater);

  const replaceAvailableUpdate = React.useCallback((next: Update | null) => {
    const previous = availableUpdateRef.current;
    availableUpdateRef.current = next;
    if (previous && previous !== next) {
      void previous.close().catch(() => undefined);
    }
  }, []);

  React.useEffect(() => {
    if (!hasAndroidUpdater) {
      return;
    }
    window.__nanotesAndroidUpdaterEvent = event => {
      if (event.type === 'check') {
        const resolver = androidCheckWaitersRef.current.get(event.requestId);
        if (resolver) {
          androidCheckWaitersRef.current.delete(event.requestId);
          resolver(event);
        }
        return;
      }
      if (event.type === 'install-started') {
        setUpdateState('downloading');
        setDownloadProgress(0);
        setUpdateError(null);
        return;
      }
      if (event.type === 'install-progress') {
        setUpdateState('downloading');
        setDownloadProgress(Math.min(100, Math.max(0, Math.round(event.percent))));
        return;
      }
      if (event.type === 'install-permission') {
        setUpdateState('available');
        setDownloadProgress(null);
        setUpdateError('Allow installs from NaNotes in Android settings, then return.');
        return;
      }
      if (event.type === 'install-cancelled') {
        setUpdateState(androidUpdateRef.current ? 'available' : 'idle');
        setDownloadProgress(null);
        return;
      }
      if (event.type === 'install-success') {
        androidUpdateRef.current = null;
        setAvailableVersion(null);
        setDownloadProgress(100);
        setUpdateError(null);
        setUpdateState('up-to-date');
        return;
      }
      if (event.type === 'install-error') {
        setDownloadProgress(null);
        setUpdateError(event.message || 'Update failed');
        setUpdateState('error');
      }
    };
    return () => {
      delete window.__nanotesAndroidUpdaterEvent;
      androidCheckWaitersRef.current.clear();
    };
  }, [hasAndroidUpdater]);

  const checkForUpdates = React.useCallback(
    async (manual: boolean) => {
      if (!supportsInAppUpdater) {
        if (manual && IS_TAURI) {
          void openUrl('https://github.com/QuillDev/nanotes/releases/latest').catch(() => undefined);
        }
        return;
      }

      lastUpdateCheckAtRef.current = Date.now();
      if (manual) {
        setUpdateState('checking');
        setUpdateError(null);
      }

      if (hasAndroidUpdater && window.NanotesAndroidUpdater) {
        try {
          const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const result = await new Promise<Extract<AndroidUpdaterEvent, { type: 'check' }>>(
            (resolve, reject) => {
              const timeout = window.setTimeout(() => {
                androidCheckWaitersRef.current.delete(requestId);
                reject(new Error('Update check timed out'));
              }, 20_000);
              androidCheckWaitersRef.current.set(requestId, event => {
                window.clearTimeout(timeout);
                resolve(event);
              });
              window.NanotesAndroidUpdater?.checkForUpdate(requestId);
            },
          );
          if (result.error) {
            throw new Error(result.error);
          }
          if (result.available && result.version && result.apkUrl && result.sha256) {
            androidUpdateRef.current = {
              version: result.version,
              apkUrl: result.apkUrl,
              sha256: result.sha256,
            };
            setAvailableVersion(result.version);
            setUpdateError(null);
            setUpdateState('available');
          } else {
            androidUpdateRef.current = null;
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
        return;
      }

      try {
        const update = await checkUpdate();
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
    [hasAndroidUpdater, replaceAvailableUpdate, supportsInAppUpdater],
  );

  const installUpdate = React.useCallback(async () => {
    if (!supportsInAppUpdater) {
      return;
    }

    if (hasAndroidUpdater && window.NanotesAndroidUpdater) {
      const candidate = androidUpdateRef.current;
      if (!candidate) {
        return;
      }
      setUpdateState('downloading');
      setDownloadProgress(0);
      setUpdateError(null);
      const current = stateRef.current;
      if (current.content !== current.savedContent) {
        await invoke<NoteSaveResult>('write_note', {
          notesDir: current.notesDir,
          notePath: current.notePath,
          content: current.content,
        }).catch(() => undefined);
      }
      window.NanotesAndroidUpdater.downloadAndInstall(
        candidate.version,
        candidate.apkUrl,
        candidate.sha256,
      );
      return;
    }

    const update = availableUpdateRef.current;
    if (!update) {
      return;
    }

    setUpdateState('downloading');
    setDownloadProgress(null);
    setUpdateError(null);

    try {
      const current = stateRef.current;
      if (current.content !== current.savedContent) {
        await invoke<NoteSaveResult>('write_note', {
          notesDir: current.notesDir,
          notePath: current.notePath,
          content: current.content,
        }).catch(() => undefined);
      }

      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          setDownloadProgress(total > 0 ? 0 : null);
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setDownloadProgress(Math.min(100, Math.round((downloaded / total) * 100)));
          }
        } else if (event.event === 'Finished') {
          setDownloadProgress(100);
        }
      });

      replaceAvailableUpdate(null);
      await relaunch();
    } catch (error: unknown) {
      setUpdateError(error instanceof Error ? error.message : String(error));
      setUpdateState('error');
    }
  }, [hasAndroidUpdater, replaceAvailableUpdate, stateRef, supportsInAppUpdater]);

  React.useEffect(() => {
    if (!IS_TAURI) {
      return;
    }

    let cancelled = false;
    void getVersion()
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
