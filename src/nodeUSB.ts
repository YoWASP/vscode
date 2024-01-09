import * as path from 'node:path';

// This variable is injected into the bundle via esbuild. It is necessary for node-gyp-build
// to discover the prebuilt native modules.
declare global {
    var __dirname_nodeUSB: string;
}
globalThis.__dirname_nodeUSB = path.join(__filename, '..', 'dummy1', 'dummy2');

// This import has to be done via the `require()` function so that the module initialization code
// is called after the variable above is set.
export const usb = new (require('usb').WebUSB)({ allowAllDevices: true });
