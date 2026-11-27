import React from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { CollabConnectionStatus } from '../collab';
import {
  DEFAULT_CLIENT_NAME,
  formatHotkey,
  IS_ANDROID,
  IS_TAURI,
} from '../desktop/config';
import type { UpdateState } from '../hooks/useAppUpdater';
import { PathInput } from './PathInput';

export interface SettingsOverlayProps {
  notesDir: string;
  onNotesDirChange: (notesDir: string) => void;
  onCommitNotesDir: () => void;
  hotkey: string;
  recordingHotkey: boolean;
  onToggleRecordHotkey: () => void;
  onStopRecordHotkey: () => void;
  appearanceOpen: boolean;
  onAppearanceOpenChange: (open: boolean) => void;
  glassTint: string;
  onGlassTintChange: (tint: string) => void;
  glassOpacity: number;
  onGlassOpacityChange: (opacity: number) => void;
  glassBlur: number;
  onGlassBlurChange: (blur: number) => void;
  syncOpen: boolean;
  onSyncOpenChange: (open: boolean) => void;
  syncUrl: string;
  onSyncUrlChange: (url: string) => void;
  syncToken: string;
  syncDeviceName: string;
  onSyncDeviceNameChange: (name: string) => void;
  onSyncDeviceNameBlur: (name: string) => void;
  collabStatus: CollabConnectionStatus;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncError: string | null;
  onSyncError: (message: string) => void;
  pairingStarting: boolean;
  pairingCode: string | null;
  pairingUrl: string | null;
  onStartSyncSignIn: () => void;
  onStopPairing: () => void;
  onRunSync: () => void;
  onSignOutSync: () => void;
  launchAtLogin: boolean;
  launchAtLoginReady: boolean;
  onToggleLaunchAtLogin: () => void;
  appVersion: string | null;
  supportsInAppUpdater: boolean;
  updateState: UpdateState;
  availableVersion: string | null;
  downloadProgress: number | null;
  updateError: string | null;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onClose: () => void;
}

export function SettingsOverlay(props: SettingsOverlayProps) {
  return (
    <div className="settingsOverlay" role="dialog" aria-modal="true" aria-label="Settings">
      <header className="settingsHeader">
        <h2 className="settingsTitle">Settings</h2>
        <button
          className="settingsClose"
          type="button"
          aria-label="Close settings"
          onClick={props.onClose}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </header>
      <div className="settingsBody">
        {IS_ANDROID ? null : (
          <>
            <label>
              <span>Notes folder</span>
              <PathInput
                value={props.notesDir}
                onChange={props.onNotesDirChange}
                onCommit={props.onCommitNotesDir}
              />
            </label>

            <div className="settingRow">
              <strong>New note hotkey</strong>
              <button
                className={props.recordingHotkey ? 'hotkeyButton hotkeyButton-recording' : 'hotkeyButton'}
                type="button"
                aria-label="Change new note hotkey"
                onClick={props.onToggleRecordHotkey}
                onBlur={props.onStopRecordHotkey}
              >
                {props.recordingHotkey ? 'Press keys…' : formatHotkey(props.hotkey)}
              </button>
            </div>

            <details
              className="settingsFold"
              open={props.appearanceOpen}
              onToggle={event => props.onAppearanceOpenChange(event.currentTarget.open)}
            >
              <summary className="settingsFoldSummary">
                <span>Appearance</span>
              </summary>

              <div className="settingsFoldBody">
                <div className="settingRow settingRow-stacked">
                  <div className="settingRowHeader">
                    <strong>Glass tint</strong>
                    <input
                      className="colorInput"
                      type="color"
                      aria-label="Glass tint"
                      value={props.glassTint}
                      onChange={event => props.onGlassTintChange(event.target.value)}
                    />
                  </div>
                </div>

                <div className="settingRow settingRow-stacked">
                  <div className="settingRowHeader">
                    <strong>Glass opacity</strong>
                    <span className="settingValue">{Math.round(props.glassOpacity * 100)}%</span>
                  </div>
                  <input
                    className="rangeInput"
                    type="range"
                    min="0.12"
                    max="0.96"
                    step="0.01"
                    aria-label="Glass opacity"
                    value={props.glassOpacity}
                    onChange={event => props.onGlassOpacityChange(Number(event.target.value))}
                  />
                </div>

                <div className="settingRow settingRow-stacked">
                  <div className="settingRowHeader">
                    <strong>Glass blur</strong>
                    <span className="settingValue">{props.glassBlur}px</span>
                  </div>
                  <input
                    className="rangeInput"
                    type="range"
                    min="0"
                    max="40"
                    step="1"
                    aria-label="Glass blur"
                    value={props.glassBlur}
                    onChange={event => props.onGlassBlurChange(Number(event.target.value))}
                  />
                </div>
              </div>
            </details>
          </>
        )}

        {IS_TAURI ? (
          <details
            className="settingsFold"
            open={props.syncOpen}
            onToggle={event => props.onSyncOpenChange(event.currentTarget.open)}
          >
            <summary className="settingsFoldSummary">
              <span>
                Sync
                {props.syncToken ? (
                  <span className="settingMeta">
                    {props.collabStatus === 'connected' ? ' live' : ' on'}
                  </span>
                ) : null}
              </span>
            </summary>

            <div className="settingsFoldBody">
              <label className="syncField">
                <span>Server URL</span>
                <input
                  type="url"
                  placeholder="https://notes.example.com"
                  value={props.syncUrl}
                  onChange={event => props.onSyncUrlChange(event.target.value)}
                />
              </label>

              <label className="syncField">
                <span>Device name</span>
                <input
                  type="text"
                  maxLength={80}
                  placeholder={DEFAULT_CLIENT_NAME}
                  value={props.syncDeviceName}
                  onChange={event => props.onSyncDeviceNameChange(event.target.value)}
                  onBlur={event => props.onSyncDeviceNameBlur(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>

              <div className="settingRow">
                <strong>
                  {props.pairingCode
                    ? `Approve ${props.pairingCode}`
                    : props.syncToken
                      ? props.syncStatus === 'error'
                        ? 'Sync error'
                        : 'Connected'
                      : 'Passkey sign-in'}
                </strong>
                <div className="syncActions">
                  {props.pairingCode ? (
                    <>
                      {props.pairingUrl ? (
                        <button
                          className="hotkeyButton hotkeyButton-recording"
                          type="button"
                          onClick={() => {
                            void openUrl(props.pairingUrl!).catch((error: unknown) => {
                              props.onSyncError(
                                `Could not open browser: ${error instanceof Error ? error.message : String(error)}`,
                              );
                            });
                          }}
                        >
                          Open
                        </button>
                      ) : null}
                      <button className="hotkeyButton" type="button" onClick={props.onStopPairing}>
                        Cancel
                      </button>
                    </>
                  ) : props.syncToken ? (
                    <>
                      <button
                        className="hotkeyButton"
                        type="button"
                        disabled={props.syncStatus === 'syncing'}
                        title={props.syncError ?? undefined}
                        onClick={props.onRunSync}
                      >
                        {props.syncStatus === 'syncing' ? 'Syncing…' : 'Sync'}
                      </button>
                      <button className="hotkeyButton" type="button" onClick={props.onSignOutSync}>
                        Sign out
                      </button>
                    </>
                  ) : (
                    <button
                      className="hotkeyButton hotkeyButton-recording"
                      type="button"
                      disabled={props.pairingStarting}
                      onClick={props.onStartSyncSignIn}
                    >
                      {props.pairingStarting ? 'Connecting…' : 'Sign in'}
                    </button>
                  )}
                </div>
              </div>
              {props.syncError ? <div className="syncError">{props.syncError}</div> : null}
            </div>
          </details>
        ) : null}

        {IS_ANDROID ? null : (
          <div className="settingRow">
            <strong>Launch at login</strong>
            <button
              className={props.launchAtLogin ? 'switch switch-on' : 'switch'}
              role="switch"
              aria-checked={props.launchAtLogin}
              aria-label="Launch at login"
              disabled={!props.launchAtLoginReady}
              type="button"
              onClick={props.onToggleLaunchAtLogin}
            >
              <span className="switchKnob" />
            </button>
          </div>
        )}

        {IS_TAURI ? (
          <div className="settingRow">
            <strong>
              Updates
              {props.appVersion ? <span className="settingMeta"> v{props.appVersion}</span> : null}
            </strong>
            <button
              className={
                props.updateState === 'available'
                  ? 'hotkeyButton hotkeyButton-recording'
                  : 'hotkeyButton'
              }
              type="button"
              disabled={props.updateState === 'checking' || props.updateState === 'downloading'}
              title={props.updateState === 'error' ? (props.updateError ?? 'Update check failed') : undefined}
              onClick={() => {
                if (props.updateState === 'available') {
                  props.onInstallUpdate();
                } else {
                  props.onCheckForUpdates();
                }
              }}
            >
              {!props.supportsInAppUpdater
                ? 'Releases'
                : props.updateState === 'checking'
                  ? 'Checking…'
                  : props.updateState === 'up-to-date'
                    ? 'Up to date'
                    : props.updateState === 'available' && props.availableVersion
                      ? `Install v${props.availableVersion}`
                      : props.updateState === 'downloading'
                        ? props.downloadProgress !== null
                          ? `Updating ${props.downloadProgress}%`
                          : 'Updating…'
                        : props.updateState === 'error'
                          ? 'Retry'
                          : 'Check'}
            </button>
          </div>
        ) : null}
        {IS_TAURI && props.updateError ? <div className="syncError">{props.updateError}</div> : null}
      </div>
    </div>
  );
}
