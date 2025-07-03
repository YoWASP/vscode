import * as vscode from 'vscode';
import { WorkerContext, WorkerThread, WorkerThreadImpl } from './workerThread';

declare var navigator: undefined | {
    usb: undefined | {
        getDevices(): Promise<any[]>
    }
};

type PackageJSON = {
    publisher?: string;
    name: string;
    version: string;
    exports: { [name: string]: string };
};

type Tree = {
    [name: string]: Tree | string | Uint8Array
};

type OutputStream =
    (bytes: Uint8Array | null) => void;

type USBDeviceFilter = {
    vendorId?: number,
    productId?: number,
    classCode?: number,
    subclassCode?: number,
    protocolCode?: number,
    serialNumber?: number
};

type Command = {
    (args?: string[], files?: Tree, options?: {
        stdout?: OutputStream | null,
        stderr?: OutputStream | null,
        decodeASCII?: boolean,
        loadPyodide?: (options: any) => Promise<any>,
        // For compatibility with applications built with @yowasp/runtime <6.0.
        printLine?: (line: string) => void,
    }): Promise<Tree>;
    requiresUSBDevice?: USBDeviceFilter[];
};

interface CommandExit extends Error {
    code: number;
    files: Tree;
}

interface CommandExitConstructor extends ErrorConstructor {
    readonly prototype: CommandExit;
}

type CommandLine = [string, ...string[]];

interface LoadBundlesMessage {
    type: 'loadBundles';
    urls: string[];
}

interface LoadPyodideMessage {
    type: 'loadPyodide';
    url: string;
}

interface ConfigurePyodideMessage {
    type: 'configurePyodide';
    packages: string[];
}

interface PrepareCommandMessage {
    type: 'prepareCommand';
    name: string;
}

interface RunCommandMessage {
    type: 'runCommand';
    command: CommandLine;
    files: Tree;
}

enum Severity {
    fatal = 'fatal',
    error = 'error',
    warning = 'warning',
    info = 'info',
}

interface DiagnosticMessage {
    type: 'diagnostic';
    severity: Severity;
    message: string;
}

interface BundlesLoadedMessage {
    type: 'bundlesLoaded';
    urls: string[];
}

interface PyodideLoadedMessage {
    type: 'pyodideLoaded';
    version: string;
}

interface TerminalOutputMessage {
    type: 'terminalOutput';
    data: Uint8Array | string | null;
}

interface RequestUSBDeviceMessage {
    type: 'requestUSBDevice';
    filters: USBDeviceFilter[];
}

interface USBDeviceRequestedMessage {
    type: 'usbDeviceRequested';
}

interface CommandDoneMessage {
    type: 'commandDone';
    code: number;
    files: Tree;
}

type HostToWorkerMessage =
    LoadBundlesMessage |
    LoadPyodideMessage |
    ConfigurePyodideMessage |
    PrepareCommandMessage |
    RunCommandMessage |
    USBDeviceRequestedMessage;

type WorkerToHostMessage =
    BundlesLoadedMessage |
    PyodideLoadedMessage |
    DiagnosticMessage |
    TerminalOutputMessage |
    RequestUSBDeviceMessage |
    CommandDoneMessage;

function workerEntryPoint(self: WorkerContext) {
    function postMessage(message: WorkerToHostMessage) {
        self.postMessage(message);
    }

    function postDiagnostic(severity: Severity, message: string) {
        postMessage({
            type: 'diagnostic',
            severity: severity,
            message: message
        });
    }

    interface Bundle {
        commands: Map<string, Command>;
        exitError: CommandExitConstructor;
    }

    const bundles: Bundle[] = [];

    async function loadBundleFromURL(url: string, urlsLoaded: string[]) {
        if (!url.endsWith('/'))
            url += '/';

        let packageJSON: PackageJSON;
        try {
            const packageJSONURL = new URL('./package.json', url);
            console.log(`[YoWASP toolchain] Loading bundle metadata from ${packageJSONURL}`);
            packageJSON = await fetch(packageJSONURL).then((resp) => resp.json());
        } catch (e) {
            postDiagnostic(Severity.error,
                `Cannot fetch package metadata for bundle ${url}: ${e}.`);
            return;
        }

        // If a bundle contains two files, /package.json and /gen/bundle.js, and the following
        // sequence happens:
        //  1. /package.json is requested and cached
        //  2. the bundle contents is updated
        //  3. /gen/bundle.js is requested and cached
        // then the bundle will have "tearing" (by analogy to display tearing): downloaded
        // resources will be partly old and partly new. This happens because there is no way
        // to invalidate all of the caches in the middle (CDN, browser, etc).
        //
        // CDNs offer a way to solve this: in addition to the /@yowasp/yosys/package.json endpoint,
        // which makes the latest version available, they also provide a version-specific endpoint,
        // typically /@yowasp/yosys@1.2.3/package.json. The contents of the latter never change.
        // Not every CDN does this, so we only use this opportunistically: if ..@1.2.3/package.json
        // serves valid JSON with the same package name.
        const qualifiedPackageName = packageJSON.publisher
            ? `@${packageJSON.publisher}/${packageJSON.name}`
            : packageJSON.name;
        if (url.endsWith(`${qualifiedPackageName}/`)) {
            const versionedURL = url.replace(new RegExp(`${qualifiedPackageName}/$`),
                `${qualifiedPackageName}@${packageJSON.version}/`);
            async function checkVersionedURL(): Promise<string> {
                const response = await fetch(new URL('./package.json', versionedURL));
                const versionedPackageJSON = await response.json();
                if (versionedPackageJSON?.version !== packageJSON.version)
                    throw new Error("metadata check failed");
                return versionedURL;
            }
            url = await checkVersionedURL().then(
                (versionedURL) => {
                    console.log(
                        `[YoWASP toolchain] Using versioned URL '${versionedURL}'`);
                    return versionedURL;
                },
                (error) => {
                    console.log(
                        `[YoWASP toolchain] Not using versioned URL '${versionedURL}': ${error}`);
                    return url;
                }
            );
        }

        let bundleNS: {
            commands: { [name: string]: Command },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            Exit: CommandExitConstructor
        };
        try {
            const entryPoint = packageJSON.exports.browser ?? packageJSON.exports.default;
            const entryPointURL = new URL(entryPoint, url);
            console.log(`[YoWASP toolchain] Importing bundle entry point from ${entryPointURL}`);
            bundleNS = await self.importModule(entryPointURL);
        } catch (e) {
            postDiagnostic(Severity.error,
                `Cannot import entry point for bundle ${url}: ${e}.`);
            return;
        }

        if (typeof bundleNS.commands !== "object" || !(bundleNS.Exit.prototype instanceof Error)) {
            postDiagnostic(Severity.error,
                `Bundle ${url} does not define any commands.`);
            return;
        }

        const commands = new Map();
        for (const [name, command] of Object.entries(bundleNS.commands)) {
            console.log(`[YoWASP toolchain] Command '${name}' defined in bundle ${url}`);
            commands.set(name, command);
        }
        bundles.push({ commands, exitError: bundleNS.Exit });
        urlsLoaded.push(url);
    }

    async function loadBundles(message: LoadBundlesMessage) {
        const urlsLoaded: string[] = [];
        await Promise.all(message.urls.map((url) => loadBundleFromURL(url, urlsLoaded)));
        postMessage({
            type: 'bundlesLoaded',
            urls: urlsLoaded
        });
    }

    let pyodideIndexURL: null | URL = null;
    let pyodideNS: null | {
        loadPyodide(options: {
            indexURL?: URL | string,
            args?: string[],
            env?: {[key: string]: string},
            jsglobals?: any,
            packages?: string[],
            stdin?: () => string | undefined,
            stdout?: (line: string) => void,
            stderr?: (line: string) => void,
        }): Promise<any>;
        version: string;
    } = null;
    let pythonRequirements: string[] = [];

    async function loadPyodide(message: LoadPyodideMessage) {
        pyodideIndexURL = new URL('./full/', message.url);
        const entryPointURL = new URL('./pyodide.mjs', pyodideIndexURL);
        try {
            console.log(`[YoWASP toolchain] Importing Pyodide entry point from ${entryPointURL}`);
            pyodideNS = await self.importModule(entryPointURL);
        } catch (e) {
            postDiagnostic(Severity.error,
                `Cannot import Pyodide entry point from ${entryPointURL}: ${e}.`);
            return;
        }
        postMessage({
            type: 'pyodideLoaded',
            version: pyodideNS!.version,
        });
    }

    async function prepareCommand(message: PrepareCommandMessage) {
        const bundle = bundles.find((bundle) => bundle.commands.has(message.name));
        const command = bundle?.commands.get(message.name);
        // Opportunistically preload the resources for this command. Do not wait for completion,
        // ignore all errors.
        if (command) {
            console.log(`[YoWASP toolchain] Preloading resources for command '${message.name}'`);
            command(undefined, undefined, {
                loadPyodide: pyodideNS?.loadPyodide,
            }).then();
        }
    }

    let usbDeviceRequested: null | (() => void) = null;

    async function runBundleCommand([argv0, ...args]: CommandLine, filesIn: Tree) {
        const bundle = bundles.find((bundle) => bundle.commands.has(argv0));
        const command = bundle?.commands.get(argv0);
        if (bundle === undefined || command === undefined) {
            postDiagnostic(Severity.fatal,
                `The command '${argv0}' was not found in any of the loaded bundles.`);
            return;
        }

        // Check if WebUSB is provided at all, either by the browser or via Node polyfill.
        if (command.requiresUSBDevice && !self.supportsUSB) {
            postDiagnostic(Severity.fatal,
                `The command '${argv0}' requires WebUSB, but it is not available.`);
            return;
        }

        // If WebUSB is provided by the browser, we need to request device permissions.
        // If WebUSB is provided by the Node polyfill, no access control is performed.
        // The Node polyfill is only available in the `importModule` context, not worker context.
        if (command.requiresUSBDevice &&
                typeof navigator !== 'undefined' && typeof navigator.usb !== 'undefined') {
            let filtersMatch = false;
            for (const usbDevice of await navigator.usb.getDevices()) {
                if (command.requiresUSBDevice.length === 0) {
                    filtersMatch = true;
                } else {
                    for (const filter of command.requiresUSBDevice) {
                        filtersMatch ||= usbDevice.vendorId === filter.vendorId;
                        filtersMatch ||= usbDevice.productId === filter.productId;
                        filtersMatch ||= usbDevice.classCode === filter.classCode;
                        filtersMatch ||= usbDevice.subclassCode === filter.subclassCode;
                        filtersMatch ||= usbDevice.serialNumber === filter.serialNumber;
                    }
                }
            }
            if (!filtersMatch) {
                postMessage({ type: 'requestUSBDevice', filters: command.requiresUSBDevice });
                // Requesting a USB device never fails, but it does not have to actually result
                // in a device, or the right device, becoming available. The application has to
                // handle these cases.
                await new Promise((resolve) => usbDeviceRequested = () => resolve(null));
            }
        }

        try {
            const filesOut = await command(args, filesIn, {
                loadPyodide: pyodideNS?.loadPyodide,
                stdout: (bytes: Uint8Array | null) =>
                    postMessage({ type: 'terminalOutput', data: bytes }),
                stderr: (bytes: Uint8Array | null) =>
                    postMessage({ type: 'terminalOutput', data: bytes }),
                decodeASCII: false,
                // For compatibility with applications built with @yowasp/runtime <6.0.
                printLine: (line: string) =>
                    postMessage({ type: 'terminalOutput', data: `${line}\n` }),
            });
            postMessage({ type: 'commandDone', code: 0, files: filesOut });
        } catch (e) {
            if (e instanceof bundle.exitError) {
                postMessage({ type: 'commandDone', code: e.code, files: e.files });
            } else {
                postDiagnostic(Severity.fatal,
                    `Command '${[argv0, ...args].join(' ')}' failed to run: ${e}.`);
            }
        }
    }

    async function runPythonCommand(args: string[], filesIn: Tree) {
        if (args[0].startsWith('-') && !['-c'].includes(args[0])) {
            postDiagnostic(Severity.fatal,
                `Only '-c' or a filename are accepted as the first argument of the 'python' command.`);
            return;
        }

        // `workerEntryPoint()` has to be self-contained, so we can't import these from anywhere.
        function writeTreeToFS(FS: any, tree: any, path = '/') {
            for(const [filename, data] of Object.entries(tree)) {
                const filepath = `${path}${filename}`;
                if (typeof data === 'string' || data instanceof Uint8Array) {
                    FS.writeFile(filepath, data);
                } else {
                    FS.mkdir(filepath);
                    writeTreeToFS(FS, data, `${filepath}/`);
                }
            }
        }

        function readTreeFromFS(FS: any, path = '/') {
            const tree: any = {};
            for (const filename of FS.readdir(path)) {
                const filepath = `${path}${filename}`;
                if (filename === '.' || filename === '..')
                    continue;
                const stat = FS.stat(filepath);
                if (FS.isFile(stat.mode)) {
                    tree[filename] = FS.readFile(filepath, { encoding: 'binary' });
                } else if (FS.isDir(stat.mode)) {
                    tree[filename] = readTreeFromFS(FS, `${filepath}/`);
                }
            }
            return tree;
        }

        const homeDir = '/root';

        let PythonError: ErrorConstructor | undefined;
        async function preparePyodide(args: string[]) {
            console.log(`[YoWASP Toolchain] Instantiating Pyodide...`);
            const pyodide = await pyodideNS!.loadPyodide({
                args: ['--', ...args],
                env: { HOME: homeDir },
                jsglobals: {
                    Object,
                    fetch: fetch.bind(globalThis),
                    setTimeout: setTimeout.bind(globalThis),
                    clearTimeout: clearTimeout.bind(globalThis),
                },
                stdout: (line: string) => postMessage({ type: 'terminalOutput', data: `${line}\n` }),
                stderr: (line: string) => postMessage({ type: 'terminalOutput', data: `${line}\n` }),
            });
            PythonError = pyodide.ffi.PythonError;
            writeTreeToFS(pyodide.FS, filesIn, `${homeDir}/`);
            // Install packages after writing to filesystem. This is done after writing files to
            // make it possible to install wheels placed in the workspace.
            console.log(`[YoWASP Toolchain] Installing packages (${pythonRequirements.join(', ')})...`);
            await pyodide.loadPackage('micropip');
            await pyodide.pyimport('micropip').install(pythonRequirements);
            return pyodide;
        }

        let pyodide;
        try {
            if (args[0] === '-c') {
                pyodide = await preparePyodide(['-c', ...args.slice(2)]);
                console.log(`[YoWASP Toolchain] Running Python string '${args.join(' ')}'...`);
                pyodide.runPython(args[1], { filename: '<string>' });
            } else {
                pyodide = await preparePyodide(args);
                console.log(`[YoWASP Toolchain] Running Python file '${args[0]}'...`);
                // This could be read from `pyodide.FS`, but error handling gets really weird.
                const pyArgv0 = `__import__("sys").argv[0]`;
                const pyReadFile = `(lambda f: (f.read(), f.close()))(open(${pyArgv0}))[0]`;
                const pyLoader = `exec(compile(${pyReadFile}, ${pyArgv0}, 'exec'))`;
                pyodide.runPython(pyLoader, { filename: '<loader>' });
            }
            const filesOut = readTreeFromFS(pyodide.FS, `${homeDir}/`);
            postMessage({ type: 'commandDone', code: 0, files: filesOut });
        } catch(e) {
            if (pyodide !== undefined && (e instanceof pyodide.ffi.PythonError)) {
                // @ts-expect-error
                postMessage({ type: 'terminalOutput', data: e.message });
                const filesOut = readTreeFromFS(pyodide.FS, `${homeDir}/`);
                postMessage({ type: 'commandDone', code: 1, files: filesOut });
            } else if (PythonError !== undefined && (e instanceof PythonError)) {
                // This branch is taken when Pyodide crashes before it is fully prepared.
                postMessage({ type: 'terminalOutput', data: e.message });
                postDiagnostic(Severity.fatal, `Failed to install Python packages.`);
            } else {
                postDiagnostic(Severity.fatal,
                    `Command 'python ${args.join(' ')}' failed to run: ${e}.`);
            }
        }
    }

    function runCommand(message: RunCommandMessage) {
        if (message.command[0] === 'python') {
            return runPythonCommand(message.command.slice(1), message.files);
        } else {
            return runBundleCommand(message.command, message.files);
        }
    }

    self.processMessage = function(message: HostToWorkerMessage) {
        switch (message.type) {
            case 'loadBundles':
                loadBundles(message);
                break;
            case 'loadPyodide':
                loadPyodide(message);
                break;
            case 'configurePyodide':
                pythonRequirements = message.packages;
                break;
            case 'prepareCommand':
                prepareCommand(message);
                break;
            case 'runCommand':
                runCommand(message);
                break;
            case 'usbDeviceRequested':
                if (usbDeviceRequested) {
                    usbDeviceRequested();
                    usbDeviceRequested = null;
                }
                break;
        }
    };
}

enum CommandType {
    Bundle = 'bundle',
    Python = 'python',
}

function classifyCommandLine([command, ]: CommandLine) {
    switch (command) {
        case 'python':
            return CommandType.Python;
        default:
            return CommandType.Bundle;
    }
}

class WorkerPseudioterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private closeEmitter = new vscode.EventEmitter<number>();
    onDidClose?: vscode.Event<number> = this.closeEmitter.event;
    private changeNameEmitter = new vscode.EventEmitter<string>();
    onDidChangeName?: vscode.Event<string> = this.changeNameEmitter.event;

    private waitOnceDone: boolean;
    private statusBarItem: null | vscode.StatusBarItem = null;

    private worker: WorkerThread;
    private bundlesLoaded: boolean = false;
    private pyodideLoaded: boolean = false;
    private scriptPosition: number = 0;
    private closeOnEnter: boolean = false;

    constructor(private script: CommandLine[], { waitOnceDone = true } = {}) {
        this.waitOnceDone = waitOnceDone;

        this.worker = new WorkerThreadImpl(workerEntryPoint);
        this.worker.processMessage = this.processMessage.bind(this);
    }

    addStatusBarItem(command: vscode.Command) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.name = this.statusBarItem.tooltip = 'YoWASP Tool Running';
        this.statusBarItem.command = command;
    }

    open(_initialDimensions: vscode.TerminalDimensions | undefined) {
        const configuration = vscode.workspace.getConfiguration('yowaspToolchain');
        let bundlesBaseURL = configuration.bundleBaseURL;
        if (!bundlesBaseURL.endsWith('/'))
            bundlesBaseURL += '/';
        const bundleURLs = configuration.bundles.map((bundleURLFragment: string) =>
            new URL(bundleURLFragment, bundlesBaseURL).toString());
        const pyodideURL = configuration.pyodideBaseURL;

        this.printSystemMessage(`Loading tools...`);
        this.setStatus('Loading tools...');
        // We support tools that use Pyodide internally (Apicula-based ones, primarily).
        // These tools cannot load Pyodide on their own because of how they're currently shipped,
        // and there's no way to detect that a tool needs Pyodide to be available. So, we always
        // load it. This shouldn't be too resource-heavy since if Pyodide is not actually used,
        // only a small loader file is imported.
        this.postMessage({
            type: 'loadPyodide',
            url: pyodideURL,
        });
        if (this.usesCommandType(CommandType.Bundle)) {
            this.postMessage({
                type: 'loadBundles',
                urls: bundleURLs
            });
        }
        if (this.usesCommandType(CommandType.Python)) {
            this.postMessage({
                type: 'configurePyodide',
                packages: configuration.pythonRequirements
            });
        }
    }

    handleInput(data: string) {
        if (this.closeOnEnter && data === '\r')
            this.closeEmitter.fire(0);
    }

    close() {
        this.statusBarItem?.dispose();
        this.worker.terminate();
    }

    private usesCommandType(commandType: CommandType) {
        return this.script.map(classifyCommandLine).includes(commandType);
    }

    private get command(): CommandLine {
        return this.script[this.scriptPosition];
    }

    private get nextCommand(): CommandLine | undefined {
        return this.script[this.scriptPosition + 1];
    }

    private postMessage(message: HostToWorkerMessage) {
        this.worker.postMessage(message);
    }

    private async processMessage(message: WorkerToHostMessage) {
        switch (message.type) {
            case 'diagnostic':
                this.showDiagnosticMessage(message);
                break;

            case 'bundlesLoaded':
                console.log(`[YoWASP toolchain] Successfully loaded bundles:`, message.urls);
                this.bundlesLoaded = true;
                this.runFirstCommandIfAllLoaded();
                break;

            case 'pyodideLoaded':
                console.log(`[YoWASP toolchain] Successfully loaded Pyodide ${message.version}`);
                this.pyodideLoaded = true;
                this.runFirstCommandIfAllLoaded();
                break;

            case 'terminalOutput':
                let text = "";
                if (typeof message.data === 'string') {
                    text = message.data;
                } else if (message.data instanceof Uint8Array) {
                    text = new TextDecoder().decode(message.data);
                }
                this.writeEmitter.fire(text.replace(/\n/g, '\r\n'));
                break;

            case 'requestUSBDevice':
                const connectDeviceButton = "Connect Device";
                const ignoreButton = "Ignore";
                const selection = await vscode.window.showInformationMessage(
                    `The '${this.command[0]}' command requests to use a USB device.`,
                    connectDeviceButton, ignoreButton);
                if (selection === connectDeviceButton) {
                    try {
                        await vscode.commands.executeCommand(
                            'workbench.experimental.requestUsbDevice',
                            message.filters);
                    } catch {
                        // Continue anyway, and let the application itself print an error:
                        // (a) the application will be able to handle the error condition anyway;
                        // (b) in many cases it's possible the user will select the wrong device.
                        // For simplicity, have only one error path, in the application itself.
                    }
                }
                this.postMessage({ type: 'usbDeviceRequested' });
                break;

            case 'commandDone':
                this.printSystemMessage(`Command exited with status ${message.code}.`,
                    message.code === 0 ? Severity.info : Severity.error);
                this.changeNameEmitter.fire('YoWASP');
                this.finishCommand(message.code, message.files);
                break;
        }
    }

    private async runFirstCommandIfAllLoaded() {
        if (this.usesCommandType(CommandType.Bundle) && !this.bundlesLoaded)
            return;
        if (this.usesCommandType(CommandType.Python) && !this.pyodideLoaded)
            return;
        await this.runCommand();
    }

    private async runNextCommand() {
        this.scriptPosition += 1;
        await this.runCommand();
    }

    private async runCommand() {
        if (this.nextCommand !== undefined) {
            // Preload the resources required by the next command in the script.
            this.postMessage({ type: 'prepareCommand', name: this.nextCommand[0] });
        }
        this.printSystemMessage(`Running '${this.command.join(' ')}'...`);
        this.changeNameEmitter.fire(`YoWASP: ${this.command[0]}`);
        this.setStatus(`Running ${this.command[0]}...`);
        this.postMessage({
            type: 'runCommand',
            command: this.command,
            files: await this.collectInputFiles()
        });
    }

    private async finishCommand(exitCode: number, outputTree: Tree) {
        this.setStatus(null);
        await this.extractOutputFiles(outputTree);
        if (exitCode === 0 && this.scriptPosition + 1 < this.script.length) {
            this.runNextCommand();
        } else if (this.waitOnceDone) {
            this.writeEmitter.fire(`\x1b[3mPress Enter to close the terminal.\x1b[0m\r\n`);
            this.closeOnEnter = true;
        } else {
            this.closeEmitter.fire(exitCode);
        }
    }

    private get workspaceFolder() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders !== undefined && workspaceFolders.length >= 1)
            return workspaceFolders[0];
        throw new Error(`Only workspaces with a single root folder are supported`);
    }

    private async collectInputFiles() {
        async function collect(uri: vscode.Uri) {
            const tree: Tree = {};
            for (const [entryName, fileType] of await vscode.workspace.fs.readDirectory(uri)) {
                const entryUri = vscode.Uri.joinPath(uri, entryName);
                if (fileType & vscode.FileType.Directory) {
                    console.log(`[YoWASP toolchain] Collecting input directory at ${entryUri}`);
                    tree[entryName] = await collect(entryUri);
                } else if (fileType & vscode.FileType.File) {
                    console.log(`[YoWASP toolchain] Reading input file at ${entryUri}`);
                    tree[entryName] = await vscode.workspace.fs.readFile(entryUri);
                } else if (fileType & vscode.FileType.SymbolicLink) {
                    console.log(`[YoWASP toolchain] Ignoring broken symbolic link at ${entryUri}`);
                } else {
                    console.log(`[YoWASP toolchain] Ignoring unknown directory entry at ${entryUri}`);
                }
            }
            return tree;
        }

        return collect(this.workspaceFolder.uri);
    }

    private async extractOutputFiles(tree: Tree) {
        function equalByteArrays(a: Uint8Array, b: Uint8Array) {
            if (a.length !== b.length)
                return false;
            for (let i = 0; i < a.length; i++)
                if (a[i] !== b[i])
                    return false;
            return true;
        }

        async function collect(tree: Tree, prefix: string) {
            for (const [name, contents] of Object.entries(tree)) {
                if (contents instanceof Uint8Array) {
                    map.set(prefix + name, contents);
                } else if (typeof contents === 'string') {
                    map.set(prefix + name, new TextEncoder().encode(contents));
                } else {
                    collect(contents, prefix + name + '/');
                }
            }
        }

        const map = new Map();
        collect(tree, '/');
        for (const [path, newContents] of map) {
            const fileUri = vscode.Uri.joinPath(this.workspaceFolder.uri, path);
            try {
                // Don't overwrite files if their content is identical. This isn't an optimization;
                // writing to read-only files will fail, which can happen e.g. when a Python command
                // is used on a workspace with a git repository in it.
                const oldContents = await vscode.workspace.fs.readFile(fileUri);
                if (equalByteArrays(oldContents, newContents))
                    continue;
            } catch {}
            await vscode.workspace.fs.writeFile(fileUri, newContents);
            console.log(`[YoWASP toolchain] Wrote output file ${path} at ${fileUri}`);
        }
    }

    private setStatus(text: string | null) {
        if (this.statusBarItem) {
            if (text !== null) {
                this.statusBarItem.text = `$(gear~spin) ${text}`;
                this.statusBarItem.show();
            } else {
                this.statusBarItem.hide();
            }
        }
    }

    private printSystemMessage(text: string, severity: Severity = Severity.info) {
        switch (severity) {
            case Severity.fatal:
            case Severity.error:
                this.writeEmitter.fire(`\x1b[1;31m${text}\x1b[0m\r\n`);
                break;
            case Severity.warning:
                this.writeEmitter.fire(`\x1b[1;33m${text}\x1b[0m\r\n`);
                break;
            case Severity.info:
                this.writeEmitter.fire(`\x1b[1m${text}\x1b[0m\r\n`);
                break;
        }
    }

    private showDiagnosticMessage(diagnostic: DiagnosticMessage) {
        switch (diagnostic.severity) {
            case Severity.fatal:
            case Severity.error:
                vscode.window.showErrorMessage(diagnostic.message);
                this.printSystemMessage(diagnostic.message, diagnostic.severity);
                if (diagnostic.severity === Severity.fatal) {
                    this.finishCommand(255, {});
                    this.changeNameEmitter.fire('YoWASP (Error)');
                }
                break;
            case Severity.warning:
                vscode.window.showWarningMessage(diagnostic.message);
                this.printSystemMessage(diagnostic.message, diagnostic.severity);
                break;
            case Severity.info:
                vscode.window.showInformationMessage(diagnostic.message);
                break;
        }
    }
}

interface ToolchainTaskDefinition extends vscode.TaskDefinition {
    commands: CommandLine[];
}

export function activate(context: vscode.ExtensionContext) {
    const disposeLater = context.subscriptions.push.bind(context.subscriptions);

    disposeLater(vscode.tasks.registerTaskProvider('yowasp', {
        async provideTasks(): Promise<vscode.Task[]> {
            return [];
        },

        resolveTask(task: vscode.Task): vscode.Task | undefined {
            const definition = task.definition as ToolchainTaskDefinition;
            return new vscode.Task(definition, vscode.TaskScope.Workspace,
                definition.commands.map((argv) => argv[0]).join(' && '),
                'YoWASP', new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
                    return new WorkerPseudioterminal(definition.commands, { waitOnceDone: false });
                }));
        }
    }));

    let buildTerminal: vscode.Terminal | null = null;
    disposeLater(vscode.commands.registerCommand('yowasp.toolchain.build', async () => {
        const configuration = vscode.workspace.getConfiguration('yowaspToolchain');
        if (configuration.buildCommands === undefined || configuration.buildCommands.length === 0) {
            const openSettingsButton = "Open Settings";
            const selection = await vscode.window.showErrorMessage(
                "Configure the build commands to run a build.", openSettingsButton);
            if (selection === openSettingsButton) {
                vscode.commands.executeCommand('workbench.action.openSettings',
                    'yowaspToolchain.buildCommands');
            }
        } else {
            buildTerminal?.dispose();

            const pty = new WorkerPseudioterminal(configuration.buildCommands);
            buildTerminal = vscode.window.createTerminal({name: 'YoWASP', pty, isTransient: true});
            buildTerminal.show(/*preserveFocus=*/true);
            pty.addStatusBarItem({
                title: "Show Terminal",
                command: 'yowasp.toolchain.showTerminal',
                arguments: [buildTerminal]
            });
        }
    }));

    disposeLater(vscode.commands.registerCommand('yowasp.toolchain.showTerminal', (terminal: vscode.Terminal) => {
        terminal.show(/*preserveFocus=*/false);
    }));

    function lexCommandLine(commandInput: string | undefined): CommandLine | undefined {
        if (commandInput === undefined)
            return undefined;

        const LEX_RE = /\s*(?<uq>[^'"\s][^\s]*)|\s*'(?<sq>([^']|'[^\s])+)'|\s*"(?<dq>([^"]|"[^\s])+)"/g;
        const lexems = [];
        for (const match of commandInput.matchAll(LEX_RE))
            lexems.push(match.groups?.uq || match.groups?.sq || match.groups?.dq || '<undefined>');
        if (lexems.length >= 1) {
            const [command, ...args] = lexems;
            return [command, ...args];
        } else {
            return undefined;
        }
    }

    let lastCommandInput: string = "";
    disposeLater(vscode.commands.registerCommand('yowasp.toolchain.runCommand', async () => {
        const commandInput = await vscode.window.showInputBox({
            prompt: 'Enter a command line',
            placeHolder: 'yosys --version',
            value: lastCommandInput,
            valueSelection: [lastCommandInput.indexOf(' ') + 1, lastCommandInput.length]
        });
        const commandLine = lexCommandLine(commandInput);
        if (commandInput !== undefined && commandLine !== undefined) {
            const terminal = vscode.window.createTerminal({
                name: 'YoWASP',
                pty: new WorkerPseudioterminal([commandLine]),
                isTransient: true
            });
            terminal.show();
            lastCommandInput = commandInput;
        }
    }));

    disposeLater(vscode.commands.registerCommand('yowasp.toolchain.requestUSBDevice', async () => {
        try {
            await vscode.commands.executeCommand('workbench.experimental.requestUsbDevice');
        } catch {
            // Cancelled.
        }
    }));
}
