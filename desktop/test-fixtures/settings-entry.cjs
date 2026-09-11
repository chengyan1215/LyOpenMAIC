'use strict';

// Exercise the real desktop bootstrap with isolated data and an existing dev
// server. Proxy only the backend child, avoiding a second Next dev lock.
const { app } = require('electron');
const path = require('node:path');
const childProcess = require('node:child_process');
if (!process.env.SETTINGS_TEST_DATA || !process.env.SETTINGS_TEST_UPSTREAM) {
  throw new Error('This fixture must be launched by verify-settings-center.mjs');
}
app.setPath('userData', process.env.SETTINGS_TEST_DATA);
app.setAppPath(path.resolve(__dirname, '..'));
// Script entry points otherwise report the Electron version instead of the
// desktop package version that electron . / the installer reports.
app.getVersion = () => require('../package.json').version;
const spawn = childProcess.spawn;
childProcess.spawn = (executable, _args, options) =>
  spawn(executable, [path.join(__dirname, 'settings-proxy.cjs')], options);
require('../main.cjs');
