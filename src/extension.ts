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
        decodeASCII?: boolean,
        print?: (chars: string) => void,
        printLine?: (line: string) => void
    }): Promise<Tree>;
    requiresUSBDevice?: USBDeviceFilter[];
};

interface LoadBundlesMessage {
    type: 'loadBundles';
    urls: string[];
}

interface PrepareCommandMessage {
    type: 'prepareCommand';
    name: string;
}

interface RunCommandMessage {
    type: 'runCommand';
    command: [string, ...string[]];
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

interface TerminalOutputMessage {
    type: 'terminalOutput';
    data: string;
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
    PrepareCommandMessage |
    RunCommandMessage |
    USBDeviceRequestedMessage;

type WorkerToHostMessage =
    BundlesLoadedMessage |
    DiagnosticMessage |
    TerminalOutputMessage |
    RequestUSBDeviceMessage |
    CommandDoneMessage;

function workerEntryPoint(self: WorkerContext) {
    function postDiagnostic(severity: Severity, message: string) {
        self.postMessage({
            type: 'diagnostic',
            severity: severity,
            message: message
        });
    }

    interface Bundle {
        commands: Map<string, Command>;
        exitError: any;
    }

    const bundles: Bundle[] = [];

    async function loadBundleFromURL(url: string, urlsLoaded: string[]) {
        if (!url.endsWith('/'))
            url += '/';

        let packageJSON: PackageJSON;
        try {
            const packageJSONURL = new URL('./package.json', url);
            console.log(`[YoWASP toolchain] Loading metadata from ${packageJSONURL}`);
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
            Exit: any
        };
        try {
            const entryPointURL = new URL(packageJSON["exports"]["browser"], url);
            console.log(`[YoWASP toolchain] Importing entry point from ${entryPointURL}`);
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
        self.postMessage({
            type: 'bundlesLoaded',
            urls: urlsLoaded
        });
    }

    async function prepareCommand(message: PrepareCommandMessage) {
        const bundle = bundles.find((bundle) => bundle.commands.has(message.name));
        const command = bundle?.commands.get(message.name);
        // Opportunistically preload the resources for this command. Do not wait for completion,
        // ignore all errors.
        if (command) {
            console.log(`[YoWASP toolchain] Preloading resources for command '${message.name}'`);
            command().then();
        }
    }

    let usbDeviceRequested: null | (() => void) = null;

    async function runCommand(message: RunCommandMessage) {
        const argv0 = message.command[0];
        const args = message.command.slice(1);

        const bundle = bundles.find((bundle) => bundle.commands.has(argv0));
        const command = bundle?.commands.get(argv0);
        if (bundle === undefined || command === undefined) {
            postDiagnostic(Severity.fatal,
                `The command '${argv0}' was not found in any of the loaded bundles.`);
            return;
        }

        if (command.requiresUSBDevice) {
            if (typeof navigator === 'undefined' || typeof navigator.usb === 'undefined') {
                postDiagnostic(Severity.fatal,
                    `The command '${argv0}' requires WebUSB, but it is not available.`);
                return;
            }

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
                self.postMessage({ type: 'requestUSBDevice', filters: command.requiresUSBDevice });
                // Requesting a USB device never fails, but it does not have to actually result
                // in a device, or the right device, becoming available. The application has to
                // handle these cases.
                await new Promise((resolve) => usbDeviceRequested = () => resolve(null));
            }
        }

        let files;
        try {
            files = await command(args, message.files, {
                decodeASCII: false,
                print(chars: string) {
                    self.postMessage({ type: 'terminalOutput', data: chars });
                },
                printLine(line: string) {
                    self.postMessage({ type: 'terminalOutput', data: `${line}\n` });
                }
            });
            self.postMessage({ type: 'commandDone', code: 0, files: files });
        } catch (e) {
            if (e instanceof bundle.exitError) {
                // @ts-ignore
                self.postMessage({ type: 'commandDone', code: e.code, files: e.files });
            } else {
                postDiagnostic(Severity.fatal,
                    `Command '${message.command.join(' ')}' failed to run: ${e}.`);
            }
        }
    }

    self.processMessage = function(message: HostToWorkerMessage) {
        switch (message.type) {
            case 'loadBundles':
                loadBundles(message);
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
            default:
                throw new Error(`Unrecognized command: ${message}`);
        }
    };
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
    private scriptPosition: number = 0;
    private closeOnEnter: boolean = false;

    constructor(private script: string[][], { waitOnceDone = true } = {}) {
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
        let baseURL = configuration.baseURL;
        if (!baseURL.endsWith('/'))
            baseURL += '/';
        const bundleURLs = configuration.bundles.map((bundleURLFragment: string) =>
            new URL(bundleURLFragment, baseURL).toString());

        this.printSystemMessage(`Loading toolchains...`);
        this.setStatus('Loading toolchains...');
        this.worker.postMessage({ type: 'loadBundles', urls: bundleURLs });
    }

    handleInput(data: string) {
        if (this.closeOnEnter && data === '\r')
            this.closeEmitter.fire(0);
    }

    close() {
        this.statusBarItem?.dispose();
        this.worker.terminate();
    }

    private get command(): string[] {
        return this.script[this.scriptPosition];
    }

    private get nextCommand(): string[] | undefined {
        return this.script[this.scriptPosition + 1];
    }

    private async processMessage(message: WorkerToHostMessage) {
        switch (message.type) {
            case 'diagnostic':
                this.showDiagnosticMessage(message);
                break;

            case 'bundlesLoaded':
                console.log(`[YoWASP toolchain] Successfully loaded bundles:`, message.urls);
                this.runCommand(this.command);
                break;

            case 'terminalOutput':
                this.writeEmitter.fire(message.data.replace('\n', '\r\n'));
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
                this.worker.postMessage({ type: 'usbDeviceRequested' });
                break;

            case 'commandDone':
                this.printSystemMessage(`Command exited with status ${message.code}.`,
                    message.code === 0 ? Severity.info : Severity.error);
                this.changeNameEmitter.fire('YoWASP');
                this.finishCommand(message.code, message.files);
                break;
        }
    }

    private async runCommand(command: string[]) {
        if (this.nextCommand !== undefined) {
            // Preload the resources required by the next command in the script.
            this.worker.postMessage({ type: 'prepareCommand', name: this.nextCommand[0] });
        }
        this.printSystemMessage(`Running '${command.join(' ')}'...`);
        this.changeNameEmitter.fire(`YoWASP: ${command[0]}`);
        this.setStatus(`Running ${command[0]}...`);
        this.worker.postMessage({
            type: 'runCommand',
            command: command,
            files: await this.collectInputFiles(command)
        });
    }

    private async finishCommand(exitCode: number, outputTree: Tree) {
        this.setStatus(null);
        await this.extractOutputFiles(outputTree);
        if (exitCode === 0 && this.scriptPosition + 1 < this.script.length) {
            // Run next command
            this.scriptPosition += 1;
            this.runCommand(this.command);
        } else if (this.waitOnceDone) {
            this.writeEmitter.fire(`\x1b[3mPress Enter to close the terminal.\x1b[0m\r\n`);
            this.closeOnEnter = true;
        } else {
            this.closeEmitter.fire(exitCode);
        }
    }

    private async collectInputFiles(command: string[]) {
        const files: Tree = {};
        for (const arg of command.slice(1)) {
            for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
                const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, arg);
                let data;
                try {
                    data = new Uint8Array(await vscode.workspace.fs.readFile(fileUri));
                    console.log(`[YoWASP toolchain] Read input file ${arg} at ${fileUri}`);
                } catch (e) {
                    continue;
                }
                let segmentIdx = -1;
                let subtree = files;
                do {
                    const nextSegmentIdx = arg.indexOf('/', segmentIdx + 1);
                    const segment = nextSegmentIdx === -1
                        ? arg.substring(segmentIdx + 1)
                        : arg.substring(segmentIdx + 1, nextSegmentIdx);
                    if (nextSegmentIdx === -1) {
                        subtree[segment] = data;
                    } else if (segment === '') {
                        /* skip segment */
                    } else {
                        subtree[segment] ??= {};
                        // @ts-ignore
                        subtree = subtree[segment];
                    }
                    segmentIdx = nextSegmentIdx;
                } while (segmentIdx !== -1);
            }
        }
        return files;
    }

    private async extractOutputFiles(tree: Tree) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders !== undefined && workspaceFolders.length >= 1) {
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
            for (const [path, contents] of map) {
                const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, path);
                await vscode.workspace.fs.writeFile(fileUri, contents);
                console.log(`[YoWASP toolchain] Wrote output file ${path} at ${fileUri}`);
            }
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
    commands: ([string, ...string[]])[];
}

export function activate(context: vscode.ExtensionContext) {
    const disposeLater = context.subscriptions.push.bind(context.subscriptions);

    disposeLater(vscode.tasks.registerTaskProvider('yowasp', {
        async provideTasks(): Promise<vscode.Task[]> {
            return [];
        },

        resolveTask(task: vscode.Task): vscode.Task | undefined {
            const definition: ToolchainTaskDefinition = <any>task.definition;
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

    function lexCommandLine(commandLine: string): string[] {
        const LEX_RE = /\s*(?<uq>[^'"\s][^\s]*)|\s*'(?<sq>([^']|'[^\s])+)'|\s*"(?<dq>([^"]|"[^\s])+)"/g;
        const lexems = [];
        for (const match of commandLine.matchAll(LEX_RE))
            lexems.push(match.groups?.uq || match.groups?.sq || match.groups?.dq || '<undefined>');
        return lexems;
    }

    let lastCommandLine: string = "";
    disposeLater(vscode.commands.registerCommand('yowasp.toolchain.runCommand', async () => {
        const commandLine = await vscode.window.showInputBox({
            prompt: 'Enter a command line',
            placeHolder: 'yosys --version',
            value: lastCommandLine,
            valueSelection: [lastCommandLine.indexOf(' ') + 1, lastCommandLine.length]
        });
        if (commandLine !== undefined) {
            const terminal = vscode.window.createTerminal({
                name: 'YoWASP',
                pty: new WorkerPseudioterminal([lexCommandLine(commandLine)]),
                isTransient: true
            });
            terminal.show();
            lastCommandLine = commandLine;
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
