// This binding is injected with `esbuild --define:USE_WEB_WORKERS=...`.
declare var USE_WEB_WORKERS: boolean;

declare global {
    interface WorkerNavigator {
        usb: object | undefined;
    }
}

import type * as nodeWorkerThreads from 'node:worker_threads';

export interface MessageChannel {
    postMessage(message: any): void;
    processMessage: (message: any) => void;
}

export interface WorkerContext extends MessageChannel {
    importModule(url: URL | string): Promise<any>;

    supportsUSB: boolean;
}

export interface WorkerThread extends MessageChannel {
    terminate(): void;
}

export interface WorkerThreadConstructor {
    new (entryPoint: (self: WorkerContext) => void): WorkerThread;
}

let WorkerThreadImpl: WorkerThreadConstructor;
if (USE_WEB_WORKERS) {
    WorkerThreadImpl = class implements MessageChannel {
        #platformWorker: Worker;

        constructor(entryPoint: (self: WorkerContext) => void) {
            function createSelf(): WorkerContext {
                const newSelf = {
                    postMessage(message: any): void {
                        self.postMessage(message);
                    },

                    processMessage: (_message: any) => {},

                    async importModule(url: URL | string): Promise<any> {
                        return await import(url.toString());
                    },

                    supportsUSB: navigator?.usb !== undefined
                };

                self.onmessage = (event) =>
                    newSelf.processMessage(event.data);

                return newSelf;
            }

            const workerCodeURL = URL.createObjectURL(new Blob(
                [`(${entryPoint.toString()})((${createSelf.toString()})());`],
                {type: "application/javascript"}
            ));
            this.#platformWorker = new Worker(workerCodeURL);
            this.#platformWorker.addEventListener('message', (event: MessageEvent) =>
                this.processMessage(event.data));
        }

        postMessage(message: any): void {
            this.#platformWorker.postMessage(message);
        }

        processMessage = (_message: any) => {};

        terminate(): void {
            this.#platformWorker.terminate();
        }
    };
} else {
    const threads: typeof nodeWorkerThreads = require('node:worker_threads');

    WorkerThreadImpl = class implements MessageChannel {
        #platformThread: nodeWorkerThreads.Worker;

        constructor(entryPoint: (self: WorkerContext) => void) {
            function createSelf(): WorkerContext {
                const path = require('node:path');
                const vm = require('node:vm');
                const threads = require('node:worker_threads');
                const crypto = require('node:crypto');

                let usb: any = undefined;
                try {
                    usb = require(path.join(threads.workerData.dirname, 'usb', 'bundle.js')).usb;
                } catch(e) {
                    console.log(`[YoWASP Toolchain] Cannot import WebUSB polyfill`, e);
                }

                // Without this the identity of builtins is different between threads, which results
                // in astonishingly confusing and difficult to deal with bugs.
                const globalThis: any = {
                    Object,
                    Boolean,
                    String,
                    Array,
                    Map,
                    Set,
                    Function,
                    Symbol,
                    Error,
                    TypeError,
                    Int8Array,
                    Int16Array,
                    Int32Array,
                    BigInt64Array,
                    Uint8Array,
                    Uint16Array,
                    Uint32Array,
                    BigUint64Array,
                    Float32Array,
                    Float64Array,
                    Buffer,
                    ArrayBuffer,
                    SharedArrayBuffer,
                    DataView,
                    WebAssembly,
                    TextDecoder,
                    TextEncoder,
                    Promise,
                    URL,
                    Blob,
                    Response,
                    TransformStream,
                    fetch,
                    console,
                    performance,
                    crypto,
                    setTimeout,
                    clearTimeout,
                    setInterval,
                    clearInterval,
                    setImmediate,
                    clearImmediate,
                    btoa,
                    atob,
                    navigator: {
                        userAgent: 'awful',
                        usb
                    },
                    importScripts: function() {
                        // Needs to be `TypeError` for Pyodide loader to switch to `await import`.
                        throw new TypeError(`importScripts() not implemented`);
                    }
                };
                // At the moment of writing, VS Code ships Node v18.15.0. This version:
                // - cannot dynamically import from https:// URLs;
                // - does not provide module.register() hook to extend the loader;
                // - does not provide vm.Module (without a flag) to load ES modules manually.
                // Thus, crimes.
                //
                // Almost all of this can be deleted when VS Code ships Node v18.19.0 or later.
                //
                // Update (2025-01-11): VS Code ships Node v20.18.0 and this code still cannot
                // be removed because `importModuleDynamically` is feature-gated behind a flag
                // (`--experimental-vm-modules`) that VS Code doesn't pass.
                //
                // I could use `require('node:module').register()` but this will enable all
                // extensions within the same extension host to import anything they want from
                // any https:// URL, which seems sketchy at best. Crimes continue.
                async function importModuleCriminally(url: URL | string): Promise<any> {
                    let code = await fetch(url).then((resp) => resp.text());
                    code = code.replace(/\bimport\.meta\.url\b/g, JSON.stringify(url));
                    code = code.replace(/\bawait import\b/g, 'await _import');
                    code = code.replace(/\(\) => import/g, '() => _import');
                    code = code.replace(/\bexport const\b/g, 'exports.');
                    code = code.replace(/\bexport\s*{([^}]+)}\s*;/g, (_match, args) =>
                        `exports={${args.replace(/(\w+)\s+as\s+(\w+)/g, '$2:$1')}};`);
                    const script = new vm.Script(code, {
                        filename: url.toString()
                    });
                    const context: any = {
                        location: {
                            href: url.toString(),
                            toString() { return url.toString(); }
                        },
                        _import: (innerURL: string) => importModuleCriminally(new URL(innerURL, url)),
                        exports: {},
                        globalThis,
                    };
                    // FIXME(not only this is cursed but it is also wrong) {
                    context.self = context;
                    Object.setPrototypeOf(context, globalThis);
                    // }
                    script.runInNewContext(context, { contextOrigin: url.toString() });
                    return context.exports;
                }

                const newSelf = {
                    postMessage(message: any): void {
                        threads.parentPort.postMessage(message);
                    },

                    processMessage: (_message: any) => {},

                    async importModule(url: URL | string): Promise<any> {
                        return importModuleCriminally(url);
                    },

                    supportsUSB: usb !== undefined
                };
                threads.parentPort.on('message', (message: any) =>
                    newSelf.processMessage(message));
                return newSelf;
            }

            const workerCode = `(${entryPoint.toString()})((${createSelf.toString()})());`;
            const workerData = { dirname: __dirname };
            this.#platformThread = new threads.Worker(workerCode, { eval: true, workerData });
            this.#platformThread.on('message', (message: any) =>
                this.processMessage(message));
        }

        postMessage(message: any): void {
            this.#platformThread.postMessage(message);
        }

        processMessage = (_message: any) => {};

        terminate(): void {
            this.#platformThread.terminate();
        }
    };
}

export { WorkerThreadImpl };
