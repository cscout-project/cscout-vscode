// (C) Copyright 2026 Ujjwal Aggarwal
//
// This file is part of CScout.
//
// CScout is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// CScout is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// along with CScout.  If not, see <http://www.gnu.org/licenses/>.

const Module = require('module');

// Setup VS Code Mocks before importing anything that uses it
class MockRange {
    constructor(public start: MockPosition, public end: MockPosition) { }
}
export class MockPosition {
    constructor(public line: number, public character: number) { }
}
class MockLocation {
    constructor(public uri: any, public range: any) { }
}
class MockHover {
    public contents: any[];
    constructor(contents: any | any[], public range?: any) {
        this.contents = Array.isArray(contents) ? contents : [contents];
    }
}
class MockCodeLens {
    constructor(public range: any, public command?: any) { }
}
class MockThemeIcon {
    constructor(public id: string) { }
}
class MockMarkdownString {
    public value: string = '';
    constructor(value?: string) {
        if (value) { this.value = value; }
    }
    appendMarkdown(s: string) {
        this.value += s;
        return this;
    }
}
class MockEventEmitter {
    private listeners: any[] = [];
    event = (listener: any) => {
        this.listeners.push(listener);
        return { dispose: () => { } };
    };
    fire(data?: any) {
        for (const l of this.listeners) { l(data); }
    }
}
class MockDisposable {
    static from(...disposables: { dispose(): any }[]) {
        return { dispose: () => disposables.forEach(d => d.dispose()) };
    }
}

export class MockDocument {
    constructor(public uri: any, public content: string) { }
    get lineCount() { return this.content.split('\n').length; }
    lineAt(line: number) {
        const lines = this.content.split('\n');
        return {
            text: lines[line] || '',
            lineNumber: line
        };
    }
    getWordRangeAtPosition(position: any, regex: RegExp) {
        return new MockRange(position, position);
    }
    getText(range?: any) {
        if (!range) { return this.content; }
        return 'checkdup';
    }
    offsetAt(position: any) {
        const lines = this.content.split('\n');
        let offset = 0;
        for (let i = 0; i < position.line; i++) {
            offset += lines[i].length + 1; // +1 for \n
        }
        offset += position.character;
        return offset;
    }
}
export let activeWatcher: MockFileSystemWatcher | undefined = undefined;
export let activeStatusBar: MockStatusBarItem | undefined = undefined;
export let mockInfoMessageChoice: string | undefined = undefined;
export function setMockInfoMessageChoice(val: string | undefined) { mockInfoMessageChoice = val; }
export function getActiveWatcher() { return activeWatcher; }
export function getActiveStatusBar() { return activeStatusBar; }
const mockCommands = new Map<string, (...args: any[]) => any>();

class MockFileSystemWatcher {
    private changeListeners: any[] = [];
    private createListeners: any[] = [];
    private deleteListeners: any[] = [];

    onDidChange(listener: any) {
        this.changeListeners.push(listener);
        return { dispose: () => { } };
    }
    onDidCreate(listener: any) {
        this.createListeners.push(listener);
        return { dispose: () => { } };
    }
    onDidDelete(listener: any) {
        this.deleteListeners.push(listener);
        return { dispose: () => { } };
    }

    fireChange(uri: any) {
        for (const l of this.changeListeners) l(uri);
    }
    fireCreate(uri: any) {
        for (const l of this.createListeners) l(uri);
    }
    fireDelete(uri: any) {
        for (const l of this.deleteListeners) l(uri);
    }
}

class MockStatusBarItem {
    public text: string = '';
    public tooltip: string = '';
    public command: any = undefined;
    show() { }
    hide() { }
    dispose() { }
}

export const mockVSCode = {
    Range: MockRange,
    Position: MockPosition,
    Location: MockLocation,
    Hover: MockHover,
    CodeLens: MockCodeLens,
    ThemeIcon: MockThemeIcon,
    MarkdownString: MockMarkdownString,
    EventEmitter: MockEventEmitter,
    Disposable: MockDisposable,
    TreeItem: class {
        public id?: string;
        public contextValue?: string;
        public description?: string;
        public tooltip?: string;
        public command?: any;
        public iconPath?: any;
        constructor(public label: any, public collapsibleState?: any) { }
    },
    TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2
    },
    StatusBarAlignment: {
        Left: 1,
        Right: 2
    },
    window: {
        showInformationMessage: (msg: string, ...items: string[]) => {
            return Promise.resolve(mockInfoMessageChoice || '');
        },
        showErrorMessage: (msg: string) => {
            console.error('VSCode Error:', msg);
            return Promise.resolve('');
        },
        createWebviewPanel: () => ({
            webview: {
                onDidReceiveMessage: () => ({ dispose: () => { } }),
                html: ''
            },
            onDidDispose: () => { }
        }),
        activeTextEditor: undefined,
        visibleTextEditors: [],
        onDidChangeActiveTextEditor: () => ({ dispose: () => { } }),
        registerTreeDataProvider: () => ({ dispose: () => { } }),
        createOutputChannel: () => ({
            append: () => { },
            appendLine: () => { }
        }),
        createStatusBarItem: () => {
            activeStatusBar = new MockStatusBarItem();
            return activeStatusBar;
        }
    },
    workspace: {
        workspaceFolders: [
            {
                uri: { fsPath: process.platform === 'win32' ? 'C:\\Mock\\Workspace' : '/mock/workspace/path', path: process.platform === 'win32' ? 'C:\\Mock\\Workspace' : '/mock/workspace/path' },
                name: 'awk',
                index: 0
            }
        ],
        getConfiguration: () => ({
            get: (key: string) => undefined
        }),
        textDocuments: [],
        onDidChangeTextDocument: () => ({ dispose: () => { } }),
        onDidCloseTextDocument: () => ({ dispose: () => { } }),
        openTextDocument: () => Promise.resolve(new MockDocument({ fsPath: 'awk/awk.c' }, 'void checkdup() {}')),
        createFileSystemWatcher: () => {
            activeWatcher = new MockFileSystemWatcher();
            return activeWatcher;
        }
    },
    commands: {
        registerCommand: (command: string, callback: (...args: any[]) => any, thisArg?: any) => {
            mockCommands.set(command, callback);
            return { dispose: () => { mockCommands.delete(command); } };
        },
        executeCommand: (command: string, ...rest: any[]) => {
            const cb = mockCommands.get(command);
            if (cb) {
                return Promise.resolve(cb(...rest));
            }
            return Promise.resolve();
        }
    },
    languages: {
        createDiagnosticCollection: () => ({
            clear: () => { },
            set: () => { },
            delete: () => { },
            dispose: () => { }
        }),
        registerHoverProvider: () => ({ dispose: () => { } }),
        registerDefinitionProvider: () => ({ dispose: () => { } }),
        registerReferenceProvider: () => ({ dispose: () => { } }),
        registerRenameProvider: () => ({ dispose: () => { } }),
        registerCodeLensProvider: () => ({ dispose: () => { } })
    },
    Uri: {
        file: (p: string) => ({ fsPath: p, path: p, toLowerCase: () => p.toLowerCase() })
    }
};
// extension.ts and the other src files import 'vscode' at the top, but the
// real vscode module only exists inside a running VS Code instance, not in
// a plain Node process. Without this, just requiring those files here would
// crash with "Cannot find module 'vscode'" before a single test could run.
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean) {
    if (request === 'vscode') {
        return 'vscode';
    }
    return originalResolve.call(this, request, parent, isMain);
};

(Module as any)._cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: mockVSCode
};
