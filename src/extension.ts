import * as vscode from 'vscode';
import { WorkerContext, WorkerThread, WorkerThreadImpl } from './workerThread';

type Tree = {
    [name: string]: Tree | string | Uint8Array
};

type Command = {
    (args?: string[], files?: Tree, options?: {
        decodeASCII?: boolean,
        print?: (chars: string) => void,
        printLine?: (line: string) => void
    }): Promise<Tree>,
};

interface LoadBundlesMessage {
    type: 'loadBundles';
    urls: string[];
}

interface RunCommandMessage {
    type: 'runCommand';
    command: [string, ...string[]];
    files: Tree;
}

enum Severity {
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

interface CommandDoneMessage {
    type: 'commandDone';
    code: number;
    files: Tree;
}

type HostToWorkerMessage = LoadBundlesMessage | RunCommandMessage;

type WorkerToHostMessage = BundlesLoadedMessage | DiagnosticMessage | TerminalOutputMessage | CommandDoneMessage;

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

        let packageJSON;
        try {
            const packageJSONURL = new URL('./package.json', url);
            console.log(`[YoWASP toolchain] Loading metadata from ${packageJSONURL}`);
            packageJSON = await fetch(packageJSONURL).then((resp) => resp.json());
        } catch (e) {
            postDiagnostic(Severity.error,
                `Cannot fetch package metadata for bundle ${url}: ${e}`);
            return;
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
                `Cannot import entry point for bundle ${url}: ${e}`);
            return;
        }

        if (typeof bundleNS.commands !== "object" || !(bundleNS.Exit.prototype instanceof Error)) {
            postDiagnostic(Severity.error,
                `Bundle ${url} does not define any commands`);
            return;
        }

        const commands = new Map();
        for (const [command, runFn] of Object.entries(bundleNS.commands)) {
            console.log(`[YoWASP toolchain] Command '${command}' defined in bundle ${url}`);
            commands.set(command, runFn);
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

    async function runCommand(message: RunCommandMessage) {
        const argv0 = message.command[0];
        const args = message.command.slice(1);

        const bundle = bundles.find((bundle) => bundle.commands.has(argv0));
        const command = bundle?.commands.get(argv0);
        if (bundle === undefined || command === undefined) {
            postDiagnostic(Severity.error,
                `Cannot run '${argv0}': Command not found in any of the loaded bundles`);
            self.postMessage({ type: 'commandDone', code: 255, files: {} });
            return;
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
                postDiagnostic(Severity.error,
                    `Command '${message.command.join(' ')}' failed to run: ${e}`);
            }
        }
    }

    self.processMessage = function(message: HostToWorkerMessage) {
        switch (message.type) {
            case 'loadBundles':
                loadBundles(message);
                break;
            case 'runCommand':
                runCommand(message);
                break;
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

    private statusBarItem: vscode.StatusBarItem;

    private worker: WorkerThread;
    private scriptPosition: number = 0;
    private closeOnEnter: boolean = false;

    constructor(private script: string[][], private waitOnceDone: boolean) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.name = 'YoWASP Toolchain';
        this.statusBarItem.tooltip = this.statusBarItem.name;

        this.worker = new WorkerThreadImpl(workerEntryPoint);
        this.worker.processMessage = this.processMessage.bind(this);
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
        this.statusBarItem.dispose();
        this.worker.terminate();
    }

    private processMessage(message: WorkerToHostMessage) {
        switch (message.type) {
            case 'diagnostic':
                this.showDiagnosticMessage(message);
                break;

            case 'bundlesLoaded':
                console.log(`[YoWASP toolchain] Successfully loaded bundles:`, message.urls);
                this.runCommand(this.script[this.scriptPosition]);
                break;

            case 'terminalOutput':
                this.writeEmitter.fire(message.data.replace('\n', '\r\n'));
                break;

            case 'commandDone':
                this.printSystemMessage(`Command exited with status ${message.code}.`,
                    message.code === 0 ? Severity.info : Severity.error);
                this.changeNameEmitter.fire('YoWASP');
                this.setStatus(null);
                this.finishCommand(message.code, message.files);
                break;
        }
    }

    private async runCommand(command: string[]) {
        this.printSystemMessage(`Running '${command.join(' ')}'...`);
        this.changeNameEmitter.fire(`YoWASP: ${command[0]}`);
        this.setStatus(`Running ${command[0]}...`);
        this.worker.postMessage({ type: 'runCommand', command, files: await this.collectInputFiles(command) });
    }

    private async finishCommand(exitCode: number, outputTree: Tree) {
        await this.extractOutputFiles(outputTree);
        if (exitCode === 0 && this.scriptPosition + 1 < this.script.length) {
            // Run next command
            this.scriptPosition += 1;
            this.runCommand(this.script[this.scriptPosition]);
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
                    const segment = nextSegmentIdx === -1 ?
                        arg.substring(segmentIdx + 1) : arg.substring(segmentIdx + 1, nextSegmentIdx);
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
        if (text !== null) {
            this.statusBarItem.text = `$(gear) ${text}`;
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    private printSystemMessage(text: string, severity: Severity = Severity.info) {
        switch (severity) {
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
            case Severity.error:
                vscode.window.showErrorMessage(diagnostic.message);
                this.printSystemMessage(diagnostic.message, diagnostic.severity);
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
    let buildTerminal: vscode.Terminal | null = null;

    context.subscriptions.push(vscode.tasks.registerTaskProvider('yowasp', {
        async provideTasks(): Promise<vscode.Task[]> {
            return [];
        },

        resolveTask(task: vscode.Task): vscode.Task | undefined {
            const definition: ToolchainTaskDefinition = <any>task.definition;
            return new vscode.Task(definition, vscode.TaskScope.Workspace,
                definition.commands.map((argv) => argv[0]).join(' && '),
                'YoWASP', new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
                    return new WorkerPseudioterminal(definition.commands, /*waitOnceDone=*/false);
                }));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('yowasp.toolchain.build', async () => {
        const configuration = vscode.workspace.getConfiguration('yowaspToolchain');
        if (configuration.buildCommands === undefined || configuration.buildCommands.length === 0) {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const OpenSettings = "Open Settings";
            const selection = await vscode.window.showErrorMessage('Configure the build commands to run a build.', OpenSettings);
            if (selection === OpenSettings) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'yowaspToolchain.buildCommands');
            }
        } else {
            buildTerminal?.dispose();
            buildTerminal = vscode.window.createTerminal({
                name: 'YoWASP',
                pty: new WorkerPseudioterminal(configuration.buildCommands, /*waitOnceDone=*/true),
                isTransient: true
            });
            buildTerminal.show(/*preserveFocus=*/true);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('yowasp.toolchain.runCommand', async () => {
        const LEX_RE = /\s*(?<uq>[^'"\s][^\s]*)|\s*'(?<sq>([^']|'[^\s])+)'|\s*"(?<dq>([^"]|"[^\s])+)"/g;
        const commandLine = await vscode.window.showInputBox({
            prompt: 'Enter a command line',
            placeHolder: 'yosys --version'
        });
        if (commandLine !== undefined) {
            const lexems = [];
            for (const match of commandLine.matchAll(LEX_RE))
                lexems.push(match.groups?.uq || match.groups?.sq || match.groups?.dq || '<undefined>');
            const terminal = vscode.window.createTerminal({
                name: 'YoWASP',
                pty: new WorkerPseudioterminal([lexems], /*waitOnceDone=*/true),
                isTransient: true
            });
            terminal.show();
        }
    }));
}
