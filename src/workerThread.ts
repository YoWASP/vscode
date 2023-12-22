/* eslint-disable @typescript-eslint/naming-convention */

export interface MessageChannel {
    postMessage(message: any): void;
    processMessage: (message: any) => void;
}

export interface WorkerContext extends MessageChannel {
    importModule(url: URL | string): Promise<any>;
}

export interface WorkerThread extends MessageChannel {
    terminate(): void;
}

export interface WorkerThreadFactory {
    new (entryPoint: (self: WorkerContext) => void): WorkerThread;
}

let WorkerThreadImpl: WorkerThreadFactory;
if (USE_WEB_WORKERS) {
    WorkerThreadImpl = class implements MessageChannel {
        #platformWorker: Worker;

        constructor(entryPoint: (self: WorkerContext) => void) {
            function createSelf(): MessageChannel {
                const newSelf = {
                    postMessage(message: any): void {
                        self.postMessage(message);
                    },

                    processMessage: (_message: any) => {},

                    async importModule(url: URL | string): Promise<any> {
                        return await import(url.toString());
                    }
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
    const vm = require('node:vm');
    const threads = require('node:worker_threads');

    WorkerThreadImpl = class implements MessageChannel {
        #platformThread: threads.Worker;

        constructor(entryPoint: (self: WorkerContext) => void) {
            function createSelf() {
                const vm = require('node:vm');
                const threads = require('node:worker_threads');

                // At the moment of writing, VS Code ships Node v18.15.0. This version:
                // - cannot dynamically import from https:// URLs;
                // - does not provide module.register() hook to extend the loader;
                // - does not provide vm.Module (without a flag) to load ES modules manually.
                // Thus, crimes.
                async function importModuleCriminally(url: URL | string): Promise<any> {
                    let code = await fetch(url).then((resp) => resp.text());
                    code = code.replace(/\bimport\.meta\.url\b/g, JSON.stringify(url));
                    code = code.replace(/\bawait import\b/g, 'await _import');
                    code = code.replace(/\bexport const\b/g, 'exports.');
                    code = code.replace(/\bexport\b/g, 'exports = ');
                    const script = new vm.Script(code, {
                        filename: url.toString()
                    });
                    const context = {
                        Error,
                        Uint8Array,
                        TextDecoder,
                        TextEncoder,
                        URL,
                        fetch,
                        console,
                        performance,
                        _import: importModuleCriminally,
                        exports: {}
                    };
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
                    }
                };
                threads.parentPort.on('message', (message: any) =>
                    newSelf.processMessage(message));
                return newSelf;
            }

            const workerCode = `(${entryPoint.toString()})((${createSelf.toString()})());`;
            this.#platformThread = new threads.Worker(workerCode, { eval: true });
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