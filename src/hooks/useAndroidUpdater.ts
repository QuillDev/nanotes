import React from 'react';

// The Android app (android/) loads this web app and adds `window.NanotesAndroidUpdater`, which
// checks GitHub releases and installs a newer, checksum-verified APK. It answers through
// `window.__nanotesAndroidUpdaterEvent`.

interface AndroidUpdateCandidate {
  version: string;
  apkUrl: string;
  sha256: string;
}

interface AndroidUpdaterBridge {
  checkForUpdate: (requestId: string) => void;
  downloadAndInstall: (version: string, apkUrl: string, sha256: string) => void;
}

type AndroidUpdaterEvent =
  | {
      type: 'check';
      requestId: string;
      available?: boolean;
      version?: string;
      apkUrl?: string;
      sha256?: string;
      error?: string;
    }
  | { type: 'install-started' }
  | { type: 'install-progress'; percent: number }
  | { type: 'install-permission' }
  | { type: 'install-cancelled' }
  | { type: 'install-success' }
  | { type: 'install-error'; message?: string };

type CheckEvent = Extract<AndroidUpdaterEvent, { type: 'check' }>;

declare global {
  interface Window {
    NanotesAndroidUpdater?: AndroidUpdaterBridge;
    __nanotesAndroidUpdaterEvent?: (event: AndroidUpdaterEvent) => void;
  }
}

export type AndroidUpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'error';

export function useAndroidUpdater() {
  const bridge = window.NanotesAndroidUpdater;
  const [updateState, setUpdateState] = React.useState<AndroidUpdateState>('idle');
  const [availableVersion, setAvailableVersion] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState<number | null>(null);
  const [updateError, setUpdateError] = React.useState<string | null>(null);
  const candidateRef = React.useRef<AndroidUpdateCandidate | null>(null);
  const checkWaitersRef = React.useRef(new Map<string, (event: CheckEvent) => void>());

  React.useEffect(() => {
    if (!bridge) {
      return;
    }
    const waiters = checkWaitersRef.current;
    window.__nanotesAndroidUpdaterEvent = event => {
      if (event.type === 'check') {
        const resolve = waiters.get(event.requestId);
        if (resolve) {
          waiters.delete(event.requestId);
          resolve(event);
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
        setUpdateError('Allow installs from nanotes in Android settings, then return.');
        return;
      }
      if (event.type === 'install-cancelled') {
        setUpdateState(candidateRef.current ? 'available' : 'idle');
        setDownloadProgress(null);
        return;
      }
      if (event.type === 'install-success') {
        candidateRef.current = null;
        setAvailableVersion(null);
        setDownloadProgress(100);
        setUpdateError(null);
        setUpdateState('up-to-date');
        return;
      }
      setDownloadProgress(null);
      setUpdateError(event.message || 'Update failed');
      setUpdateState('error');
    };
    return () => {
      delete window.__nanotesAndroidUpdaterEvent;
      waiters.clear();
    };
  }, [bridge]);

  const checkForUpdates = React.useCallback(
    async (manual: boolean) => {
      if (!bridge) {
        return;
      }
      if (manual) {
        setUpdateState('checking');
        setUpdateError(null);
      }
      try {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await new Promise<CheckEvent>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            checkWaitersRef.current.delete(requestId);
            reject(new Error('Update check timed out'));
          }, 20_000);
          checkWaitersRef.current.set(requestId, event => {
            window.clearTimeout(timeout);
            resolve(event);
          });
          bridge.checkForUpdate(requestId);
        });
        if (result.error) {
          throw new Error(result.error);
        }
        if (result.available && result.version && result.apkUrl && result.sha256) {
          candidateRef.current = { version: result.version, apkUrl: result.apkUrl, sha256: result.sha256 };
          setAvailableVersion(result.version);
          setUpdateError(null);
          setUpdateState('available');
        } else {
          candidateRef.current = null;
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
    [bridge],
  );

  const installUpdate = React.useCallback(() => {
    const candidate = candidateRef.current;
    if (!bridge || !candidate) {
      return;
    }
    setUpdateState('downloading');
    setDownloadProgress(0);
    setUpdateError(null);
    bridge.downloadAndInstall(candidate.version, candidate.apkUrl, candidate.sha256);
  }, [bridge]);

  // Look once shortly after the app opens.
  React.useEffect(() => {
    if (!bridge) {
      return;
    }
    const timer = window.setTimeout(() => void checkForUpdates(false), 3000);
    return () => window.clearTimeout(timer);
  }, [bridge, checkForUpdates]);

  return {
    supported: Boolean(bridge),
    updateState,
    availableVersion,
    downloadProgress,
    updateError,
    checkForUpdates,
    installUpdate,
  };
}
