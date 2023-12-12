import * as vscode from 'vscode';
import type * as yowasp from '@yowasp/runtime';

interface LoadBundlesMessage {
    type: 'loadBundles';
    urls: string[];
}

interface RunCommandMessage {
    type: 'runCommand';
    command: [string, ...string[]];
    files: yowasp.Tree;
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
    line: string;
}

interface CommandDoneMessage {
    type: 'commandDone';
    code: number;
    files: yowasp.Tree;
}

type HostToWorkerMessage = LoadBundlesMessage | RunCommandMessage;

type WorkerToHostMessage = BundlesLoadedMessage | DiagnosticMessage | TerminalOutputMessage | CommandDoneMessage;

function workerEntryPoint() {
    function postDiagnostic(severity: Severity, message: string) {
        postMessage({
            type: 'diagnostic',
            severity: severity,
            message: message
        });
    }

    interface Bundle {
        commands: Map<string, yowasp.Application['run']>;
        exitError: any;
    }

    const bundles: Bundle[] = [];

    async function loadBundles(message: LoadBundlesMessage) {
        const bundleURLsLoaded = [];
        for (let bundleURL of message.urls) {
            if (!bundleURL.endsWith('/'))
                bundleURL += '/';

            let packageJSON;
            try {
                const packageJSONURL = new URL('./package.json', bundleURL);
                console.log(`[YoWASP toolchain] Loading metadata from ${packageJSONURL}`);
                packageJSON = await fetch(packageJSONURL).then((resp) => resp.json());
            } catch (e) {
                postDiagnostic(Severity.error,
                    `Cannot fetch package metadata for bundle ${bundleURL}: ${e}`);
                continue;
            }

            let bundleNS: {
                commands: { [name: string]: yowasp.Application['run'] },
                // eslint-disable-next-line @typescript-eslint/naming-convention
                Exit: any
            };
            try {
                const entryPointURL = new URL(packageJSON["exports"]["browser"], bundleURL);
                console.log(`[YoWASP toolchain] Importing entry point from ${entryPointURL}`);
                bundleNS = await import(entryPointURL.toString());
            } catch (e) {
                postDiagnostic(Severity.error,
                    `Cannot import entry point for bundle ${bundleURL}: ${e}`);
                continue;
            }

            if (typeof bundleNS.commands !== "object" || !(bundleNS.Exit.prototype instanceof Error)) {
                postDiagnostic(Severity.error,
                    `Bundle ${bundleURL} does not define any commands`);
                continue;
            }

            const commands = new Map();
            for (const [command, runFn] of Object.entries(bundleNS.commands)) {
                console.log(`[YoWASP toolchain] Command '${command}' defined in bundle ${bundleURL}`);
                commands.set(command, runFn);
            }
            bundles.push({ commands, exitError: bundleNS.Exit });
            bundleURLsLoaded.push(bundleURL);
        }
        postMessage({
            type: 'bundlesLoaded',
            urls: bundleURLsLoaded
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
            postMessage({ type: 'commandDone', code: 255, files: {} });
            return;
        }

        let files;
        try {
            files = await command(args, message.files, {
                decodeASCII: false,
                printLine(line: string) {
                    postMessage({ type: 'terminalOutput', line });
                }
            });
            postMessage({ type: 'commandDone', code: 0, files: files });
        } catch (e) {
            if (e instanceof bundle.exitError) {
                // @ts-ignore
                postMessage({ type: 'commandDone', code: e.code, files: e.files });
            } else {
                postDiagnostic(Severity.error,
                    `Command '${message.command.join(' ')}' failed to run: ${e}`);
            }
        }
    }

    self.onmessage = function(event: MessageEvent<HostToWorkerMessage>) {
        switch (event.data.type) {
            case 'loadBundles':
                loadBundles(event.data);
                break;
            case 'runCommand':
                runCommand(event.data);
                break;
        }
    };
}

const workerURL = URL.createObjectURL(new Blob(
    [`(${workerEntryPoint.toString()})();`],
    {type: "application/javascript"}
));

class WorkerPseudioterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private closeEmitter = new vscode.EventEmitter<number>();
    onDidClose?: vscode.Event<number> = this.closeEmitter.event;
    private changeNameEmitter = new vscode.EventEmitter<string>();
    onDidChangeName?: vscode.Event<string> = this.changeNameEmitter.event;

    private statusBarItem: vscode.StatusBarItem;

    private worker: Worker;
    private scriptPosition: number = 0;
    private closeOnInput: boolean = false;

    constructor(private script: string[][], private waitOnceDone: boolean) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.name = 'YoWASP Toolchain';
        this.statusBarItem.tooltip = this.statusBarItem.name;

        this.worker = new Worker(workerURL);
        this.worker.addEventListener('message', (event: MessageEvent<WorkerToHostMessage>) =>
            this.handleMessage(event.data));
    }

    open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
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

    handleInput(_data: string): void {
        if (this.closeOnInput)
            this.closeEmitter.fire(0);
    }

    close(): void {
        this.statusBarItem.dispose();
        this.worker.terminate();
    }

    private handleMessage(message: WorkerToHostMessage) {
        switch (message.type) {
            case 'diagnostic':
                this.showDiagnosticMessage(message);
                break;

            case 'bundlesLoaded':
                console.log(`[YoWASP toolchain] Successfully loaded bundles:`, message.urls);
                this.runCommand(this.script[this.scriptPosition]);
                break;

            case 'terminalOutput':
                this.writeEmitter.fire(message.line + '\r\n');
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

    private async finishCommand(exitCode: number, outputTree: yowasp.Tree) {
        await this.extractOutputFiles(outputTree);
        if (exitCode === 0 && this.scriptPosition + 1 < this.script.length) {
            // Run next command
            this.scriptPosition += 1;
            this.runCommand(this.script[this.scriptPosition]);
        } else if (this.waitOnceDone) {
            this.writeEmitter.fire(`\x1b[3mPress any key to close the terminal.\x1b[0m\r\n`);
            this.closeOnInput = true;
        } else {
            this.closeEmitter.fire(exitCode);
        }
    }

    private async collectInputFiles(command: string[]) {
        const files: yowasp.Tree = {};
        for (const arg of command.slice(1)) {
            for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
                const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, arg);
                let data;
                try {
                    data = await vscode.workspace.fs.readFile(fileUri);
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

    private async extractOutputFiles(tree: yowasp.Tree) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders !== undefined && workspaceFolders.length >= 1) {
            async function collect(tree: yowasp.Tree, prefix: string) {
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

    context.subscriptions.push(vscode.commands.registerCommand('yowasp.toolchain.runBuild', async () => {
        const configuration = vscode.workspace.getConfiguration('yowaspToolchain');
        if (configuration.buildCommands === undefined || configuration.buildCommands.length === 0) {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const OpenSettings = "Open Settings";
            const selection = await vscode.window.showErrorMessage('Configure the build commands to run a build.', OpenSettings);
            if (selection === OpenSettings) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'yowaspToolchain.buildCommands');
            }
        } else {
            if (buildTerminal)
                buildTerminal.dispose();

            const terminal = vscode.window.createTerminal({
                name: 'YoWASP',
                pty: new WorkerPseudioterminal(configuration.buildCommands, /*waitOnceDone=*/true),
                isTransient: true
            });
            terminal.show(/*preserveFocus=*/true);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('yowasp.toolchain.runCommand', async () => {
        const commandLine = await vscode.window.showInputBox({
            prompt: 'Enter a command line',
            placeHolder: 'yosys --version'
        });
        if (commandLine !== undefined) {
            const terminal = vscode.window.createTerminal({
                name: 'YoWASP',
                pty: new WorkerPseudioterminal([commandLine.split(/\s+/)], /*waitOnceDone=*/true),
                isTransient: true
            });
            terminal.show();
        }
    }));
}
