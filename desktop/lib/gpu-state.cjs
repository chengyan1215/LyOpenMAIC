'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Persisted GPU rendering state, kept separate from desktop-settings.json:
 * that file is strictly versioned and tied to encrypted API keys, while this
 * one is written frequently and must tolerate corruption silently.
 *
 * Shape:
 *   mode              'auto' | 'hardware' | 'software'  (user preference)
 *   failures          consecutive GPU child-process crashes ever recorded
 *   lastLaunchGpuMode 'hardware' | 'software' | ''       (what we tried last)
 *   lastLaunchClean   boolean                            (did the last run exit gracefully?)
 */

const DEFAULT_STATE = Object.freeze({
  mode: 'auto',
  failures: 0,
  lastLaunchGpuMode: '',
  lastLaunchClean: false,
});

function gpuStateFilePath(userDataDirectory) {
  return path.join(userDataDirectory, 'gpu-state.json');
}

function loadGpuState(userDataDirectory) {
  try {
    const raw = JSON.parse(fs.readFileSync(gpuStateFilePath(userDataDirectory), 'utf8'));
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    return {
      mode: ['auto', 'hardware', 'software'].includes(raw.mode) ? raw.mode : 'auto',
      failures: Number.isInteger(raw.failures) && raw.failures > 0 ? raw.failures : 0,
      lastLaunchGpuMode: raw.lastLaunchGpuMode === 'hardware' || raw.lastLaunchGpuMode === 'software'
        ? raw.lastLaunchGpuMode
        : '',
      lastLaunchClean: raw.lastLaunchClean === true,
    };
  } catch {
    // Missing or corrupt state = first run / wiped state. Fail open to auto.
    return { ...DEFAULT_STATE };
  }
}

function saveGpuState(userDataDirectory, state) {
  try {
    fs.mkdirSync(userDataDirectory, { recursive: true });
    const temporaryPath = `${gpuStateFilePath(userDataDirectory)}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, gpuStateFilePath(userDataDirectory));
  } catch {
    // Best effort only; the app must start even if this write fails.
  }
}

module.exports = { loadGpuState, saveGpuState, DEFAULT_GPU_STATE: DEFAULT_STATE };
