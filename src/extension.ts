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
// You should have received a copy of the GNU General Public License
// along with CScout.  If not, see <http://www.gnu.org/licenses/>.


import * as cp from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    CScoutCallEntry,
    CScoutClient,
    CScoutFile,
    CScoutFunction,
    CScoutHoverData,
    CScoutHoverFunction,
    CScoutIdentifier,
    CScoutIdentifierClassStat,
    CScoutLocation,
    IdentifierFilters,
    FunctionFilters,
} from './cscoutClient';
import { CScoutLifecycle, CScoutState } from './lifecycle';
import { IdentifierResolver, Resolution } from './identifierResolver';
import { pickFunction } from './identity';
import { CScoutSettings } from './buildSystem';
import { toEditorPath, toCScoutPath, checkDependency, commandRunsInWsl } from './platform';

// TODO: this file has grown big, it would be worth pulling pieces out into
// their own files, something like treeProviders.ts, editorProviders.ts,
// a webviews folder, and diagnostics.ts, so activate() at the bottom just
// wires everything together.

let cscoutVersion: string | undefined;

async function detectCScoutVersion(binaryPath: string): Promise<void> {
    try {
        const execFileAsync = util.promisify(cp.execFile);
        const { stdout } = await execFileAsync(binaryPath, ['--version']);
        const match = /(\d+\.\d+(\.\d+)?)/.exec(stdout);
        if (match) {
            cscoutVersion = match[1];
        }
    } catch {
        // Version detection is best-effort; leave undefined if it fails.
    }
}

const CSCOUT_KEY_FIRST_ACTIVATION = 'cscout.firstActivationShown';

function getCustomIcon(context: vscode.ExtensionContext, iconName: string) {
    return {
        light: vscode.Uri.file(context.asAbsolutePath(`resources/icons/light/${iconName}.svg`)),
        dark: vscode.Uri.file(context.asAbsolutePath(`resources/icons/dark/${iconName}.svg`))
    };
}

function friendlyErrorLabel(err: unknown): string {
	const message = (err as Error)?.message ?? String(err);
	if (/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i.test(message)) {
		return 'CScout stopped';
	}
	return `Error: ${message}`;
}

function friendlyErrorMessage(err: unknown): string {
    const message = (err as Error)?.message ?? String(err);
    if (/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i.test(message)) {
        return 'CScout stopped';
    }
    return message;
}

// -----------------------------------------------------------------------
// Settings helpers
// -----------------------------------------------------------------------

function loadSettings(): CScoutSettings {
    const cfg = vscode.workspace.getConfiguration('cscout');
    const cscocoPy = cfg.get<string>('cscocoPyPath', 'cscoco.py');
    // If csapiPyPath isn't set explicitly, derive it from cscocoPyPath by
    // swapping the filename. That way someone who only configures cscoco.py's
    // path doesn't also have to set csapi.py's path separately when the two
    // scripts live side by side, which is the normal install layout.
    const csapiPy =
        cfg.get<string>('csapiPyPath') ||
        (cscocoPy && cscocoPy.endsWith('cscoco.py')
            ? cscocoPy.replace(/cscoco\.py$/, 'csapi.py')
            : 'csapi.py');

    return {
        host: cfg.get<string>('host', 'localhost'),
        port: cfg.get<number>('port', 0),
        cscoutBinaryPath: cfg.get<string>('binaryPath', 'cscout'),
        cscocoPyPath: cscocoPy,
        csapiPyPath: csapiPy,
        csmakePath: cfg.get<string>('csmakePath', 'csmake'),
        pythonPath: cfg.get<string>('pythonPath', 'python3'),
        sqlite3Path: cfg.get<string>('sqlite3Path', 'sqlite3'),
        autoStart: cfg.get<boolean>('autoStart', false),
        projectName: cfg.get<string>('projectName') || undefined,
    };
}

// -----------------------------------------------------------------------
// Sidebar providers
// -----------------------------------------------------------------------

export type Node =
    | { kind: 'identifier'; id: CScoutIdentifier; groupKey: string }
    | { kind: 'file'; file: CScoutFile; groupKey: string }
    | { kind: 'function'; fn: CScoutFunction; groupKey: string }
    | { kind: 'group'; label: string; count?: number; groupKey: string }
    | { kind: 'action'; label: string; command: string; icon?: string; args?: any[] }
    | { kind: 'empty'; label: string }
    | { kind: 'load-more'; groupKey: string; offset: number; total: number };

export class IdentifierTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;

    // Bounded memory: only stores items currently shown in each group.
    // Key: groupKey, Value: items fetched so far for that group.
    private groupItems: Map<string, CScoutIdentifier[]> = new Map();
    // Total counts per group, from /identifiers/counts endpoint.
    private groupTotals: Map<string, number> = new Map();
    // Root-level counts (for folder labels), fetched once per refresh.
    private counts: Record<string, number> | null = null;

    constructor(
        private getClient: () => CScoutClient | undefined,
        private context: vscode.ExtensionContext
    ) { }

    refresh(): void {
        this.groupItems.clear();
        this.groupTotals.clear();
        this.counts = null;
        this._emitter.fire();
    }

    /** Called by cscout.loadMore command, fetches next 200 from server and appends. */
    async loadMore(node: any): Promise<void> {
        if (!node?.groupKey) return;
        const client = this.getClient();
        if (!client) return;
        const stored = this.groupItems.get(node.groupKey) ?? [];
        try {
            const page = await client.getIdentifiers(this.filtersFor(node.groupKey, stored.length, 200));
            this.groupItems.set(node.groupKey, [...stored, ...page]);
            this._emitter.fire();
        } catch (err) {
            vscode.window.showErrorMessage(`CScout: failed to load more: ${friendlyErrorMessage(err)}`);
        }
    }

    /** Map group keys to the right /identifiers filter params for server-side pagination. */
    private filtersFor(groupKey: string, offset: number, limit: number): IdentifierFilters {
        return groupKey === 'all' 
            ? { limit, offset } 
            : { query: groupKey.replace(/-/g, '_'), limit, offset };
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'empty') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        }
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label };
            item.iconPath = new vscode.ThemeIcon(node.icon ?? 'play');
            return item;
        }
        if (node.kind === 'group') {
            const label = node.count !== undefined ? `${node.label} (${node.count})` : node.label;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);

            const iconMap: Record<string, string> = {
                'all': 'format-list-bulleted',
                'readonly': 'lock-outline',
                'writable': 'pencil-outline',
                'file-spanning': 'file-link-outline',
                'unused-project': 'archive-outline',
                'unused-file': 'file-hidden',
                'unused-macros': 'code-tags-off',
                'static-vars': 'variable-box',
                'static-funs': 'function-variant'
            };
            const iconName = iconMap[node.groupKey] ?? 'format-list-bulleted';
            item.iconPath = getCustomIcon(this.context, iconName);

            return item;
        }
        if (node.kind === 'load-more') {
            const remaining = node.total - node.offset;
            const item = new vscode.TreeItem(
                `Load ${Math.min(200, remaining)} more… (${remaining} remaining)`,
                vscode.TreeItemCollapsibleState.None
            );
            item.iconPath = new vscode.ThemeIcon('chevron-down');
            item.command = {
                command: 'cscout.loadMore',
                title: 'Load more',
                arguments: [node],
            };
            return item;
        }
        if (node.kind !== 'identifier') { return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None); }
        const id = node.id;
        const item = new vscode.TreeItem(id.NAME, vscode.TreeItemCollapsibleState.None);
        item.id = `${node.groupKey}-identifier-${id.EID}`;
        const kindStr = describeIdKind(id).join(', ');
        item.description = kindStr;
        item.tooltip = new vscode.MarkdownString(
            `**${id.NAME}**  \n${kindStr}  \nEID: \`${id.EID}\`  \n` +
            (id.UNUSED ? 'Unused  \n' : '') +
            (id.READONLY ? 'Read-only  \n' : 'Writable  \n')
        );
        item.iconPath = iconForId(id);
        item.command = {
            command: 'cscout.gotoIdentifier',
            title: 'Go to identifier',
            arguments: [id.EID],
        };
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        const client = this.getClient();
        if (!client) return [];

        if (!node) {
            // Root: fetch counts only (single lightweight query, no row data).
            if (!this.counts) {
                try {
                    this.counts = await client.getIdentifierCounts();
                } catch (err) {
                    return [{ kind: 'empty', label: friendlyErrorLabel(err) }];
                }
            }
            const c = this.counts;
            return [
                { kind: 'group', label: 'All identifiers', count: c['all'], groupKey: 'all' },
                { kind: 'group', label: 'Read-only identifiers', count: c['readonly'], groupKey: 'readonly' },
                { kind: 'group', label: 'Writable identifiers', count: c['writable'], groupKey: 'writable' },
                { kind: 'group', label: 'File-spanning writable identifiers', count: c['file_spanning'], groupKey: 'file-spanning' },
                { kind: 'group', label: 'Unused project-scoped writable identifiers', count: c['unused_project'], groupKey: 'unused-project' },
                { kind: 'group', label: 'Unused file-scoped writable identifiers', count: c['unused_file'], groupKey: 'unused-file' },
                { kind: 'group', label: 'Unused writable macros', count: c['unused_macros'], groupKey: 'unused-macros' },
                { kind: 'group', label: 'Writable variable identifiers that should be static', count: c['static_vars'], groupKey: 'static-vars' },
                { kind: 'group', label: 'Writable function identifiers that should be static', count: c['static_funs'], groupKey: 'static-funs' },
                { kind: 'action', label: 'View Identifier Statistics', command: 'cscout.showIdentifierStats', icon: 'table' },
            ];
        }

        if (node.kind === 'group') {
            const stored = this.groupItems.get(node.groupKey);
            if (!stored) {
                // First expand: fetch first page from server.
                try {
                    const page = await client.getIdentifiers(this.filtersFor(node.groupKey, 0, 200));
                    this.groupItems.set(node.groupKey, page);
                    const total = this.counts?.[this.countKey(node.groupKey)] ?? page.length;
                    this.groupTotals.set(node.groupKey, total);
                    const items: Node[] = page.map(id => ({ kind: 'identifier' as const, id, groupKey: node.groupKey }));
                    if (page.length === 0) return [{ kind: 'empty', label: 'No identifiers' }];
                    if (total > page.length) {
                        items.push({ kind: 'load-more', groupKey: node.groupKey, offset: page.length, total });
                    }
                    return items;
                } catch (err) {
                    return [{ kind: 'empty', label: friendlyErrorLabel(err) }];
                }
            }
            // Subsequent renders use cached (already-fetched) items.
            const total = this.groupTotals.get(node.groupKey) ?? stored.length;
            const items: Node[] = stored.map(id => ({ kind: 'identifier' as const, id, groupKey: node.groupKey }));
            if (total > stored.length) {
                items.push({ kind: 'load-more', groupKey: node.groupKey, offset: stored.length, total });
            }
            return items;
        }

        return [];
    }

    /** Map groupKey to the field name in /identifiers/counts response. */
    private countKey(groupKey: string): string {
        const map: Record<string, string> = {
            'all': 'all', 'readonly': 'readonly', 'writable': 'writable',
            'file-spanning': 'file_spanning', 'unused-project': 'unused_project',
            'unused-file': 'unused_file', 'unused-macros': 'unused_macros',
            'static-vars': 'static_vars', 'static-funs': 'static_funs',
        };
        return map[groupKey] ?? groupKey;
    }
}

class ActionTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;
    private state: CScoutState = 'stopped';

    setState(state: CScoutState) {
        this.state = state;
        this.refresh();
    }

    refresh(): void {
        this._emitter.fire();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label, arguments: node.args };

            switch (node.command) {
                case 'cscout.start': item.iconPath = new vscode.ThemeIcon('play'); break;
                case 'cscout.stop': item.iconPath = new vscode.ThemeIcon('debug-stop'); break;
                case 'cscout.refresh': item.iconPath = new vscode.ThemeIcon('refresh'); break;
                case 'cscout.reanalyze': item.iconPath = new vscode.ThemeIcon('sync'); break;
                case 'workbench.action.openSettings': item.iconPath = new vscode.ThemeIcon('settings'); break;
                case 'cscout.showWalkthrough': item.iconPath = new vscode.ThemeIcon('book'); break;
                case 'cscout.verifySetup': item.iconPath = new vscode.ThemeIcon('check'); break;
                default: item.iconPath = new vscode.ThemeIcon('play');
            }
            return item;
        }
        return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None);
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (node) return [];

        if (this.state === 'stopped' || this.state === 'error') {
            return [
                { kind: 'action', label: 'Start CScout', command: 'cscout.start' },
                { kind: 'action', label: 'Tutorial', command: 'cscout.showWalkthrough' },
                { kind: 'action', label: 'Configure CScout', command: 'workbench.action.openSettings', args: ['cscout'] },
                { kind: 'action', label: 'Verify Setup', command: 'cscout.verifySetup' }
            ];
        } else {
            return [
                { kind: 'action', label: 'Stop CScout', command: 'cscout.stop' },
                { kind: 'action', label: 'Refresh UI', command: 'cscout.refresh' },
                { kind: 'action', label: 'Re-analyze Codebase', command: 'cscout.reanalyze' },
                { kind: 'action', label: 'Configure CScout', command: 'workbench.action.openSettings', args: ['cscout'] },
                { kind: 'action', label: 'Verify Setup', command: 'cscout.verifySetup' }
            ];
        }
    }
}

export class FileTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;

    // Bounded memory: only stores pages the user has actually expanded.
    private groupItems: Map<string, CScoutFile[]> = new Map();
    private groupTotals: Map<string, number> = new Map();
    private counts: Record<string, number> | null = null;

    constructor(
        private getClient: () => CScoutClient | undefined,
        private context: vscode.ExtensionContext
    ) { }

    refresh(): void {
        this.groupItems.clear();
        this.groupTotals.clear();
        this.counts = null;
        this._emitter.fire();
    }

    /** Called by cscout.loadMore command, fetches next 200 from server and appends. */
    async loadMore(node: any): Promise<void> {
        if (!node?.groupKey) return;
        const client = this.getClient();
        if (!client) return;
        const stored = this.groupItems.get(node.groupKey) ?? [];
        try {
            const page = await this.fetchPage(client, node.groupKey, stored.length, 200);
            this.groupItems.set(node.groupKey, [...stored, ...page]);
            this._emitter.fire();
        } catch (err) {
            vscode.window.showErrorMessage(`CScout: failed to load more: ${friendlyErrorMessage(err)}`);
        }
    }

    /** Fetch a page of files for a specific group from the server. */
    private async fetchPage(client: CScoutClient, groupKey: string, offset: number, limit: number): Promise<CScoutFile[]> {
        // The files endpoint has no limit/offset support server side, so we
        // pull the whole list and slice it here. File lists are much smaller
        // than identifier lists, so this is fine.
        const query = groupKey === 'all' ? undefined : groupKey.replace(/-/g, '_');
        const allFiles = await client.getFiles(query);
        return allFiles.slice(offset, offset + limit);
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'empty') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        }
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label };
            item.iconPath = new vscode.ThemeIcon(node.icon ?? 'play');
            return item;
        }
        if (node.kind === 'group') {
            const item = new vscode.TreeItem(
                `${node.label} (${node.count ?? 0})`,
                vscode.TreeItemCollapsibleState.Collapsed
            );

            const iconMap: Record<string, string> = {
                'all': 'folder-multiple-outline',
                'readonly': 'folder-lock-outline',
                'writable': 'folder-edit-outline',
                'with-unused-project': 'folder-alert-outline',
                'with-unused-file': 'folder-alert-outline',
                'no-statements': 'folder-outline',
                'unprocessed': 'folder-sync-outline',
                'with-strings': 'folder-text-outline',
                'h-with-includes': 'folder-pound-outline'
            };
            const iconName = iconMap[node.groupKey] ?? 'folder-outline';
            item.iconPath = getCustomIcon(this.context, iconName);

            return item;
        }
        if (node.kind === 'load-more') {
            const remaining = node.total - node.offset;
            const item = new vscode.TreeItem(
                `Load ${Math.min(200, remaining)} more… (${remaining} remaining)`,
                vscode.TreeItemCollapsibleState.None
            );
            item.iconPath = new vscode.ThemeIcon('chevron-down');
            item.command = { command: 'cscout.loadMore', title: 'Load more', arguments: [node] };
            return item;
        }
        if (node.kind !== 'file') {
            return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None);
        }
        const file = node.file;
        const uri = vscode.Uri.file(toEditorPath(file.NAME));
        const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('file-code');

        const rwText = file.RO ? 'read-only' : 'writable';
        const complexity = (file as any).COMPLEXITY || 0;
        item.description = `${rwText}${complexity ? `  ·  complexity ${complexity}` : ''}`;

        item.tooltip = `${file.NAME}\nStatus: ${file.RO ? 'read-only' : 'writable'}`;
        item.command = {
            command: 'cscout.openFile',
            title: 'Open',
            arguments: [file.NAME],
        };
        item.contextValue = 'cscoutFile';
        item.id = `${node.groupKey}-file-${file.FID}`;
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        const client = this.getClient();
        if (!client) return [];

        if (!node) {
            // Root: single count query, no row data.
            if (!this.counts) {
                try {
                    this.counts = await client.getFileCounts();
                } catch (err) {
                    return [{ kind: 'empty', label: friendlyErrorLabel(err) }];
                }
            }
            const c = this.counts;
            return [
                { kind: 'group', label: 'All files', count: c['all'], groupKey: 'all' },
                { kind: 'group', label: 'Read-only files', count: c['readonly'], groupKey: 'readonly' },
                { kind: 'group', label: 'Writable files', count: c['writable'], groupKey: 'writable' },
                { kind: 'group', label: 'Files containing unused project-scoped identifiers', count: c['with_unused_project'], groupKey: 'with-unused-project' },
                { kind: 'group', label: 'Files containing unused file-scoped identifiers', count: c['with_unused_file'], groupKey: 'with-unused-file' },
                { kind: 'group', label: 'Writable .c files without statements', count: c['no_statements'], groupKey: 'no-statements' },
                { kind: 'group', label: 'Writable files with unprocessed lines', count: c['unprocessed'], groupKey: 'unprocessed' },
                { kind: 'group', label: 'Writable files containing strings', count: c['with_strings'], groupKey: 'with-strings' },
                { kind: 'group', label: 'Writable .h files with #include directives', count: c['h_with_includes'], groupKey: 'h-with-includes' },
                { kind: 'action', label: 'View File Metrics Table', command: 'cscout.showFileMetricsAggregate', icon: 'table' },
            ];
        }

        if (node.kind === 'group') {
            const stored = this.groupItems.get(node.groupKey);
            if (!stored) {
                try {
                    const page = await this.fetchPage(client, node.groupKey, 0, 200);
                    this.groupItems.set(node.groupKey, page);
                    const countKey = node.groupKey.replace(/-/g, '_');
                    const total = this.counts?.[countKey] ?? page.length;
                    this.groupTotals.set(node.groupKey, total);
                    if (page.length === 0) return [{ kind: 'empty', label: 'No files' }];
                    const result: Node[] = page.map(file => ({ kind: 'file' as const, file, groupKey: node.groupKey }));
                    if (total > page.length) {
                        result.push({ kind: 'load-more', groupKey: node.groupKey, offset: page.length, total });
                    }
                    return result;
                } catch (err) {
                    return [{ kind: 'empty', label: friendlyErrorLabel(err) }];
                }
            }
            const total = this.groupTotals.get(node.groupKey) ?? stored.length;
            const result: Node[] = stored.map(file => ({ kind: 'file' as const, file, groupKey: node.groupKey }));
            if (total > stored.length) {
                result.push({ kind: 'load-more', groupKey: node.groupKey, offset: stored.length, total });
            }
            return result;
        }

        return [];
    }
}

export class FunctionTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;

    // Bounded memory: only stores the pages the user has actually expanded.
    private groupItems: Map<string, CScoutFunction[]> = new Map();
    private groupTotals: Map<string, number> = new Map();
    private counts: Record<string, number> | null = null;

    constructor(
        private getClient: () => CScoutClient | undefined,
        private context: vscode.ExtensionContext
    ) { }

    refresh(): void {
        this.groupItems.clear();
        this.groupTotals.clear();
        this.counts = null;
        this._emitter.fire();
    }

    /** Called by cscout.loadMore command, fetches next 200 from server and appends. */
    async loadMore(node: any): Promise<void> {
        if (!node?.groupKey) return;
        const client = this.getClient();
        if (!client) return;
        const stored = this.groupItems.get(node.groupKey) ?? [];
        try {
            const page = await client.getFunctions(this.filtersFor(node.groupKey, stored.length, 200));
            this.groupItems.set(node.groupKey, [...stored, ...page]);
            this._emitter.fire();
        } catch (err) {
            vscode.window.showErrorMessage(`CScout: failed to load more: ${friendlyErrorMessage(err)}`);
        }
    }

    private filtersFor(groupKey: string, offset: number, limit: number): FunctionFilters {
        return groupKey === 'all' 
            ? { limit, offset } 
            : { query: groupKey.replace(/-/g, '_'), limit, offset };
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'empty') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        }
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label };
            item.iconPath = new vscode.ThemeIcon(node.icon ?? 'play');
            return item;
        }
        if (node.kind === 'group') {
            const label = node.count !== undefined ? `${node.label} (${node.count})` : node.label;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);

            const iconMap: Record<string, string> = {
                'all': 'bookshelf',
                'project-scoped': 'earth',
                'file-scoped': 'file-outline',
                'not-called': 'phone-missed',
                'called-once': 'numeric-1-box-outline'
            };
            const iconName = iconMap[node.groupKey] ?? 'bookshelf';
            item.iconPath = getCustomIcon(this.context, iconName);

            return item;
        }
        if (node.kind === 'load-more') {
            const remaining = node.total - node.offset;
            const item = new vscode.TreeItem(
                `Load ${Math.min(200, remaining)} more… (${remaining} remaining)`,
                vscode.TreeItemCollapsibleState.None
            );
            item.iconPath = new vscode.ThemeIcon('chevron-down');
            item.command = { command: 'cscout.loadMore', title: 'Load more', arguments: [node] };
            return item;
        }
        if (node.kind !== 'function') {
            return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None);
        }
        const fn = node.fn;
        const item = new vscode.TreeItem(fn.NAME, vscode.TreeItemCollapsibleState.None);
        item.id = `${node.groupKey}-function-${fn.ID}`;
        item.iconPath = new vscode.ThemeIcon(fn.ISMACRO ? 'symbol-constant' : 'symbol-function');

        const tooltip = new vscode.MarkdownString();
        tooltip.supportThemeIcons = true;
        tooltip.appendMarkdown(`**${fn.NAME}**\n\n`);
        tooltip.appendMarkdown(`$(sign-in) **Fan-in:** ${fn.FANIN} (Incoming)\n\n`);
        tooltip.appendMarkdown(`$(sign-out) **Fan-out:** ${fn.FANOUT ?? 0} (Outgoing)\n\n`);
        if (fn && fn.CCYCL1 !== null) {
            tooltip.appendMarkdown(`$(pulse) **Complexity:** ${fn.CCYCL1_PRE ?? '?'} (Pre-CPP), ${fn.CCYCL1} (Post-CPP)`);
        }
        item.tooltip = tooltip;
        item.command = {
            command: 'cscout.openFunctionLocation',
            arguments: [fn],
            title: 'Go to definition',
        };
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        const client = this.getClient();
        if (!client) return [];

        if (!node) {
            // Root: single count query only.
            if (!this.counts) {
                try {
                    this.counts = await client.getFunctionCounts();
                } catch (err) {
                    return [{ kind: 'empty', label: friendlyErrorLabel(err) }];
                }
            }
            const c = this.counts;
            return [
                { kind: 'group', label: 'All functions', count: c['all'], groupKey: 'all' },
                { kind: 'group', label: 'Project-scoped writable functions', count: c['project_scoped'], groupKey: 'project-scoped' },
                { kind: 'group', label: 'File-scoped writable functions', count: c['file_scoped'], groupKey: 'file-scoped' },
                { kind: 'group', label: 'Writable functions not directly called', count: c['not_called'], groupKey: 'not-called' },
                { kind: 'group', label: 'Writable functions called exactly once', count: c['called_once'], groupKey: 'called-once' },
                { kind: 'action', label: 'View Function Metrics Table', command: 'cscout.showFunMetricsAggregate', icon: 'table' },
            ];
        }

        if (node.kind === 'group') {
            const stored = this.groupItems.get(node.groupKey);
            if (!stored) {
                try {
                    const page = await client.getFunctions(this.filtersFor(node.groupKey, 0, 200));
                    this.groupItems.set(node.groupKey, page);
                    const countKey = node.groupKey.replace('-', '_');
                    const total = this.counts?.[countKey] ?? page.length;
                    this.groupTotals.set(node.groupKey, total);
                    const items: Node[] = page.map(fn => ({ kind: 'function' as const, fn, groupKey: node.groupKey }));
                    if (page.length === 0) return [{ kind: 'empty', label: 'No functions' }];
                    if (total > page.length) {
                        items.push({ kind: 'load-more', groupKey: node.groupKey, offset: page.length, total });
                    }
                    return items;
                } catch (err) {
                    return [{ kind: 'empty', label: friendlyErrorLabel(err) }];
                }
            }
            const total = this.groupTotals.get(node.groupKey) ?? stored.length;
            const items: Node[] = stored.map(fn => ({ kind: 'function' as const, fn, groupKey: node.groupKey }));
            if (total > stored.length) {
                items.push({ kind: 'load-more', groupKey: node.groupKey, offset: stored.length, total });
            }
            return items;
        }
        return [];
    }
}

class FileDepsTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;

    constructor(
        private getClient: () => CScoutClient | undefined,
        private context?: vscode.ExtensionContext
    ) { }

    refresh(): void { this._emitter.fire(); }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'group') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);

            switch (node.groupKey) {
                case 'include':
                    item.iconPath = new vscode.ThemeIcon('project');
                    break;
                case 'compile':
                    item.iconPath = new vscode.ThemeIcon('circuit-board');
                    break;
                case 'control':
                    item.iconPath = this.context
                        ? getCustomIcon(this.context, 'control-graph')
                        : new vscode.ThemeIcon('graph');
                    break;
                case 'data':
                    item.iconPath = new vscode.ThemeIcon('references');
                    break;
                default:
                    item.iconPath = new vscode.ThemeIcon('project');
            }
            return item;
        }
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label, arguments: node.args };

            if (node.label.toLowerCase().includes('writable')) {
                item.iconPath = new vscode.ThemeIcon('edit');
            } else {
                item.iconPath = new vscode.ThemeIcon('files');
            }
            return item;
        }
        if (node.kind === 'empty') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        }
        return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None);
    }

    getChildren(node?: Node): Node[] {
        const client = this.getClient();
        if (!client) {
            return [];
        }
        if (!node) {
            return [
                { kind: 'group', label: 'File include graph', groupKey: 'include' },
                { kind: 'group', label: 'Compile-time dependency graph', groupKey: 'compile' },
                { kind: 'group', label: 'Control dependency graph (function calls)', groupKey: 'control' },
                { kind: 'group', label: 'Data dependency graph (global variables)', groupKey: 'data' },
            ];
        }
        if (node.kind === 'group') {
            return [
                { kind: 'action', label: 'Writable files', command: 'cscout.showFileDep', args: [node.groupKey, true] },
                { kind: 'action', label: 'All files', command: 'cscout.showFileDep', args: [node.groupKey, false] },
            ];
        }
        return [];
    }
}

// -----------------------------------------------------------------------
// Identifier utility functions
// -----------------------------------------------------------------------

function describeIdKind(id: CScoutIdentifier): string[] {
    const attributes: string[] = [];

    // 1. Core Type (Most important)
    if (id.FUN) attributes.push('Function');
    if (id.MACRO) attributes.push('Macro');
    if (id.TYPEDEF) attributes.push('Typedef');
    if (id.ENUM) attributes.push('Enumeration constant');
    if (id.SUETAG) attributes.push('Tag for struct/union/enum');
    if (id.SUMEMBER) attributes.push('Member of struct/union');
    if (id.LABEL) attributes.push('Label');
    if (id.MACROARG) attributes.push('Macro argument');

    // Scope (CSCOPE/LSCOPE) is deliberately left out here. It's already shown
    // on its own "Scope:" line in the hover, so listing it here too would
    // just duplicate that.

    // 2. Modifiers
    if (id.READONLY) {
        attributes.push('Read-only');
    } else {
        attributes.push('Writable');
    }
    if (id.UNDEFMACRO) attributes.push('Undefined macro');
    if (id.UNDEFEDMACRO) attributes.push('Undefed macro');
    if (id.REDEFEDSAMEMACRO) attributes.push('Macro redefined with same value');
    if (id.REDEFEDDIFFMACRO) attributes.push('Macro redefined with different value');

    // 3. Low-priority internal classifications
    if (id.ORDINARY) attributes.push('Ordinary identifier');
    if (id.YACC) attributes.push('Yacc identifier');

    if (id.UNUSED) attributes.push('Unused');

    return attributes;
}

function iconForId(id: CScoutIdentifier): vscode.ThemeIcon {
    let baseIcon = 'symbol-variable'; // Default for Ordinary identifier

    if (id.MACRO) {
        baseIcon = 'symbol-constant';
    } else if (id.FUN) {
        baseIcon = 'symbol-function';
    } else if (id.TYPEDEF) {
        baseIcon = 'symbol-type-parameter';
    } else if (id.SUETAG) {
        baseIcon = 'symbol-struct';
    } else if (id.ENUM) {
        baseIcon = 'symbol-enum-member';
    } else if (id.SUMEMBER) {
        baseIcon = 'symbol-field';
    } else if (id.LABEL) {
        baseIcon = 'symbol-keyword';
    } else if (id.YACC) {
        baseIcon = 'symbol-string';
    }

    if (id.UNUSED) {
        return new vscode.ThemeIcon(baseIcon, new vscode.ThemeColor('problemsWarningIcon.foreground'));
    }

    return new vscode.ThemeIcon(baseIcon);
}


// -----------------------------------------------------------------------
// Editor providers: hover, definition, references, rename
// -----------------------------------------------------------------------

// Waits ms milliseconds, but returns early (with true) the moment the token
// is cancelled, instead of always waiting the full delay. Used to debounce
// hover and codelens: if the user moves on before 150ms passes, we skip the
// request entirely instead of firing it and throwing the result away.
async function delayUntilCancelled(ms: number, token: vscode.CancellationToken): Promise<boolean> {
    if (token.isCancellationRequested) return true;
    return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
            disposable.dispose();
            resolve(token.isCancellationRequested);
        }, ms);
        const disposable = token.onCancellationRequested(() => {
            clearTimeout(timeout);
            disposable.dispose();
            resolve(true);
        });
    });
}

function fallbackNote(res: Extract<Resolution, { kind: 'uncertain' }>): string {
    const how = res.via === 'unique-name'
        ? 'it is the only identifier with this name'
        : res.via === 'line-column'
            ? 'it has this name at this column of the analyzed line'
            : 'it has this name on the analyzed line';
    const why = res.why === 'edited'
        ? 'this part of the file changed since the last analysis'
        : res.why === 'not-analyzed'
            ? 'this file was not part of the last analysis'
            : 'identifier positions for this file could not be loaded';
    return `$(warning) **Possibly a different identifier:** matched because ${how}, since ${why}. Re-analyze to be sure.`;
}

function renameRefusal(res: Resolution): string {
    return res.kind === 'uncertain' && res.why !== 'edited'
        ? `CScout can't rename '${res.name}' safely: it can't confirm which identifier this is. Re-analyze first.`
        : `CScout can't rename '${res.name}' safely: this part of the file changed since the last analysis. Re-analyze first.`;
}

export class CScoutHoverProvider implements vscode.HoverProvider {
    constructor(
        private resolver: IdentifierResolver,
        private isAnalysisStale: () => boolean
    ) { }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        if (await delayUntilCancelled(150, token)) return undefined;
        let res: Resolution | undefined;
        try {
            res = await this.resolver.resolve(document, position, token);
        } catch {
            return undefined;
        }
        if (!res || token.isCancellationRequested) return undefined;

        const md = new vscode.MarkdownString(undefined, true);
        if (res.kind === 'unmatched') {
            md.appendMarkdown(`$(warning) **${res.name}** could not be matched to the last CScout analysis: this part of the file changed since it ran. Re-analyze to see its details.`);
            return new vscode.Hover(md, res.range);
        }

        let data: CScoutHoverData;
        try {
            data = await this.resolver.getHoverData(res.eid);
        } catch {
            return undefined;
        }
        if (token.isCancellationRequested) return undefined;
        const id = data.identifier;
        md.isTrusted = true;

        md.appendMarkdown(`### $(symbol-${id.FUN ? 'function' : id.MACRO ? 'constant' : 'variable'}) ${id.NAME}\n\n`);
        md.appendMarkdown(`**Kind:** ${describeIdKind(id).join(', ')}  \n`);

        const scope = id.LSCOPE ? 'Project scope' : id.CSCOPE ? 'File scope' : 'Local';
        md.appendMarkdown(`**Scope:** ${scope}  \n`);

        // The function whose whole name is this identifier, chosen by
        // definition (see pickFunction), never by name.
        const pick = id.FUN ? pickFunction(data.functions, res.fid) : undefined;
        if (pick?.kind === 'one' && pick.fn.CCYCL1 !== null) {
            md.appendMarkdown(`**Cyclomatic complexity:** ${pick.fn.CCYCL1_PRE ?? '?'} (Pre-CPP), ${pick.fn.CCYCL1} (Post-CPP)  \n`);
        } else if (pick?.kind === 'ambiguous') {
            md.appendMarkdown(`**Defined in ${pick.definitions.length} places**, so no single complexity applies  \n`);
        }

        if (data.file_count > 1) {
            md.appendMarkdown(`**Crosses file boundaries** (${data.file_count} files)  \n`);
        }

        if (data.should_be_static) {
            md.appendMarkdown(`\n💡 **Should be static** - only accessed within a single file  \n`);
        }

        if (id.UNUSED && !id.READONLY) md.appendMarkdown(`\n⚠ **Unused** - whole-program analysis  \n`);
        if (id.READONLY) md.appendMarkdown(`🔒 Read-only  \n`);

        if (res.kind === 'uncertain') {
            md.appendMarkdown(`\n${fallbackNote(res)}  \n`);
        } else if (res.modified || this.isAnalysisStale()) {
            md.appendMarkdown(`\n$(info) Source files changed since the last analysis, so these details may be out of date.  \n`);
        }

        const links = [
            `[Inspect](command:cscout.inspect?${encodeURIComponent(JSON.stringify([id.EID]))})`,
            `[Find References](command:cscout.findReferences?${encodeURIComponent(JSON.stringify([id.EID]))})`,
        ];
        if (res.kind === 'exact') {
            links.push(`[Rename](command:cscout.rename?${encodeURIComponent(JSON.stringify([{ line: res.range.start.line, character: res.range.start.character }]))})`);
        }
        if (id.FUN) {
            // A known function goes straight to its graph; otherwise
            // showCallGraph asks which definition to use.
            const graphArgs = pick?.kind === 'one' ? [pick.fn.ID, true, id.NAME] : [id.EID];
            links.push(`[Call Graph](command:cscout.showCallGraph?${encodeURIComponent(JSON.stringify(graphArgs))})`);
        }
        md.appendMarkdown(`\n---\n${links.join(' | ')}`);

        return new vscode.Hover(md, res.range);
    }
}

class CScoutDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private getClient: () => CScoutClient | undefined, private resolver: IdentifierResolver) { }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        const client = this.getClient();
        if (!client) return;
        try {
            const res = await this.resolver.resolve(document, position, token);
            if (!res || res.kind === 'unmatched' || token.isCancellationRequested) return;

            const data = await this.resolver.getHoverData(res.eid);
            if (token.isCancellationRequested) return;
            if (data.identifier.FUN) {
                const pick = pickFunction(data.functions, res.fid);
                const defs = pick.kind === 'one' ? [pick.fn] : pick.kind === 'ambiguous' ? pick.definitions : [];
                const locations = defs
                    .filter((f) => f.DEF_FILE && f.DEF_LNUM)
                    .map((f) => new vscode.Location(
                        vscode.Uri.file(toEditorPath(f.DEF_FILE as string)),
                        new vscode.Position((f.DEF_LNUM as number) - 1, 0)
                    ));
                if (locations.length > 0) return locations;
            }
            // Ask for up to 999999 locations so the real definition doesn't get cut off
            // if it's far down the list. Not real pagination, just a limit big enough
            // to cover every project we've seen.
            const detail = await client.getIdentifier(res.eid, 999999);
            if (token.isCancellationRequested) return;
            const located = detail.locations.filter((l) => l.LNUM !== null);
            const defLoc = located.find((l) => !l.RO) ?? located[0];
            return defLoc ? [locationToVSCode(defLoc)] : undefined;
        } catch {
            return;
        }
    }
}

class CScoutReferenceProvider implements vscode.ReferenceProvider {
    constructor(private getClient: () => CScoutClient | undefined, private resolver: IdentifierResolver) { }

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        const client = this.getClient();
        if (!client) return;
        try {
            const res = await this.resolver.resolve(document, position, token);
            if (!res || res.kind === 'unmatched' || token.isCancellationRequested) return;
            // Same 999999 workaround as the definition lookup above, so Find All
            // References doesn't miss anything either.
            const detail = await client.getIdentifier(res.eid, 999999);
            return detail.locations.filter((l) => l.LNUM !== null).map(locationToVSCode);
        } catch {
            return;
        }
    }
}

class CScoutRenameProvider implements vscode.RenameProvider {
    constructor(
        private getClient: () => CScoutClient | undefined,
        private resolver: IdentifierResolver,
        private channel: vscode.OutputChannel
    ) { }

    /*
     * Rename edits code, so it needs an exact match: an identifier
     * matched only by name could be a different one. Returning undefined
     * leaves the position to other rename providers; throwing tells VS
     * Code why CScout declined.
     */
    async prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Range | undefined> {
        const res = await this.resolver.resolve(document, position, token);
        if (!res) return undefined;
        if (res.kind !== 'exact') {
            throw new Error(renameRefusal(res));
        }
        return res.range;
    }

    async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        token: vscode.CancellationToken
    ): Promise<vscode.WorkspaceEdit | undefined> {
        const client = this.getClient();
        if (!client) return;
        const res = await this.resolver.resolve(document, position, token);
        if (!res) return;
        if (res.kind !== 'exact') {
            vscode.window.showErrorMessage(renameRefusal(res));
            return;
        }
        const oldName = res.name;

        try {
            const preview = await client.previewRename(res.eid, newName);
            if (!preview.locations || preview.locations.length === 0) {
                vscode.window.showErrorMessage(`CScout: no occurrences of '${oldName}' found to rename.`);
                return;
            }

            const byFile = new Map<string, CScoutLocation[]>();
            for (const loc of preview.locations) {
                const list = byFile.get(loc.FILE) ?? [];
                list.push(loc);
                byFile.set(loc.FILE, list);
            }

            let skippedCount = 0;
            const edit = new vscode.WorkspaceEdit();
            for (const [file, locs] of byFile) {
                // Fix Windows URI casing mismatch: use the open document's URI.
                let uri = vscode.Uri.file(toEditorPath(file));
                const lowerFsPath = uri.fsPath.toLowerCase();
                const openDoc = document.uri.fsPath.toLowerCase() === lowerFsPath
                    ? document
                    : vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === lowerFsPath);
                if (openDoc) {
                    uri = openDoc.uri;
                }

                // A document with a token map knows where every occurrence
                // is now, even after edits. If some occurrences sit in text
                // changed since analysis, the map has lost them and renaming
                // the rest would leave the code half renamed.
                const mapped = openDoc ? this.resolver.mappedOccurrences(openDoc, res.eid) : undefined;
                if (mapped) {
                    if (mapped.length < locs.length) {
                        vscode.window.showErrorMessage(
                            `CScout: ${locs.length - mapped.length} occurrence(s) of '${oldName}' in ${path.basename(uri.fsPath)} are in text changed since the last analysis. Re-analyze before renaming.`
                        );
                        return;
                    }
                    for (const range of mapped) {
                        edit.replace(uri, range, newName);
                    }
                    continue;
                }

                let doc: vscode.TextDocument;
                try {
                    doc = openDoc ?? await vscode.workspace.openTextDocument(uri);
                } catch (e) {
                    this.channel.appendLine(`Cannot open ${file} to rename: ${friendlyErrorMessage(e)}`);
                    skippedCount += locs.length;
                    continue;
                }
                for (const loc of locs) {
                    if (loc.LNUM === null) {
                        skippedCount++;
                        continue;
                    }
                    // CScout counts \r\n as 2 bytes. VS Code on Windows
                    // normalizes to \n-only, so positionAt() expects an offset
                    // that doesn't count \r chars. For a token on LNUM (1-based)
                    // there are (LNUM-1) \r bytes to subtract.
                    const crlfAdjust = doc.eol === vscode.EndOfLine.CRLF ? (loc.LNUM - 1) : 0;
                    const start = doc.positionAt(loc.FOFFSET - crlfAdjust);
                    const range = new vscode.Range(start, start.translate(0, oldName.length));
                    const found = doc.getText(range);
                    if (found !== oldName) {
                        this.channel.appendLine(`Skipped '${oldName}' at ${file}:${loc.LNUM}: the text there is now '${found}'.`);
                        skippedCount++;
                        continue;
                    }
                    edit.replace(uri, range, newName);
                }
            }
            if (edit.size === 0) {
                const msg = skippedCount > 0
                    ? `CScout: found occurrences of '${oldName}' but couldn't safely edit any of them (${skippedCount} skipped). See the CScout output channel for details.`
                    : `CScout: no occurrences of '${oldName}' found to rename.`;
                vscode.window.showErrorMessage(msg);
            } else if (skippedCount > 0) {
                vscode.window.showWarningMessage(`CScout: renamed '${oldName}', but skipped ${skippedCount} occurrences that could not be verified. See the CScout output channel for details.`);
            }
            return edit;
        } catch (err) {
            vscode.window.showErrorMessage(`CScout: rename failed: ${friendlyErrorMessage(err)}`);
            this.channel.appendLine(`Rename exception: ${(err as Error).stack || err}`);
            return;
        }
    }
}

function locationToVSCode(loc: CScoutLocation): vscode.Location {
    const uri = vscode.Uri.file(toEditorPath(loc.FILE));
    const line = Math.max(0, (loc.LNUM || 1) - 1);
    return new vscode.Location(uri, new vscode.Position(line, 0));
}

// -----------------------------------------------------------------------
// Diagnostics: unused identifiers surfaced in Problems panel
// -----------------------------------------------------------------------

// Turns a (file, line) location from the server into an exact range to
// highlight, trying four ways in order until one works. The server's byte
// offset is fastest, but only used if the text sitting at that offset
// actually matches name (it can go stale). Otherwise fall back to a
// whole-word regex on that line, then a plain substring search, then just
// highlighting the whole line if nothing else matched.
async function resolveRange(
    file: string,
    loc: CScoutLocation,
    name: string,
    docCache: Map<string, vscode.TextDocument>
): Promise<vscode.Range> {
    try {
        if (loc.LNUM === null) {
            return new vscode.Range(0, 0, 0, 200);
        }
        let doc = docCache.get(file);
        if (!doc) {
            doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            docCache.set(file, doc);
        }

        if (loc.FOFFSET !== undefined && loc.FOFFSET !== null) {
            const startPos = doc.positionAt(loc.FOFFSET);
            const endPos = doc.positionAt(loc.FOFFSET + name.length);
            const text = doc.getText(new vscode.Range(startPos, endPos));
            if (text === name) {
                return new vscode.Range(startPos, endPos);
            }
        }

        const line = loc.LNUM - 1;
        const lineText = doc.lineAt(line).text;
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedName}\\b`);
        const match = regex.exec(lineText);
        if (match && match.index !== undefined) {
            return new vscode.Range(line, match.index, line, match.index + name.length);
        } else {
            const idx = lineText.indexOf(name);
            if (idx >= 0) {
                return new vscode.Range(line, idx, line, idx + name.length);
            } else {
                return new vscode.Range(line, 0, line, lineText.length);
            }
        }
    } catch {
        const line = loc.LNUM === null ? 0 : loc.LNUM - 1;
        return new vscode.Range(line, 0, line, 200);
    }
}

async function refreshDiagnostics(
    client: CScoutClient,
    diagnostics: vscode.DiagnosticCollection
): Promise<void> {
    diagnostics.clear();
    try {
        const [unused, shouldStatic] = await Promise.all([
            client.getIdentifiers({ query: 'unused', limit: 5000 }),
            client.getIdentifiers({ query: 'should_be_static', limit: 5000 })
        ]);

        const byFile = new Map<string, vscode.Diagnostic[]>();
        const docCache = new Map<string, vscode.TextDocument>();

        // Limit how many we resolve locations for, since resolving each hits
        // the server. Prioritize ordinary identifiers and functions.
        const worthUnused = unused.filter((id) => !id.READONLY && (id.ORDINARY || id.FUN || id.MACRO)).slice(0, 500);
        const worthStatic = shouldStatic.filter((id) => !id.TYPEDEF && !id.ENUM && !id.SUETAG).slice(0, 500);

        for (const id of worthUnused) {
            try {
                const detail = await client.getIdentifier(id.EID);
                for (const loc of detail.locations) {
                    if (loc.LNUM === null) continue;
                    const file = toEditorPath(loc.FILE);
                    const list = byFile.get(file) || [];
                    const range = await resolveRange(file, loc, id.NAME, docCache);
                    list.push(
                        new vscode.Diagnostic(
                            range,
                            `CScout: unused identifier '${id.NAME}'`,
                            vscode.DiagnosticSeverity.Warning
                        )
                    );
                    byFile.set(file, list);
                }
            } catch {
                /* skip identifiers that fail to resolve */
            }
        }

        for (const id of worthStatic) {
            try {
                const detail = await client.getIdentifier(id.EID);
                const loc = detail.locations.find((l) => l.LNUM !== null);
                if (!loc) continue;
                const file = toEditorPath(loc.FILE);
                const list = byFile.get(file) || [];
                const range = await resolveRange(file, loc, id.NAME, docCache);
                const typeStr = id.FUN ? 'function' : 'variable';
                list.push(
                    new vscode.Diagnostic(
                        range,
                        `CScout: ${typeStr} '${id.NAME}' should be static`,
                        vscode.DiagnosticSeverity.Information
                    )
                );
                byFile.set(file, list);
            } catch {
                /* skip identifiers that fail to resolve */
            }
        }

        for (const [file, list] of byFile) {
            diagnostics.set(vscode.Uri.file(file), list);
        }
    } catch {
        /* server may be down, leave problems empty */
    }
}

// -----------------------------------------------------------------------
// CodeLens provider: shows caller/callee/complexity counts above functions
// -----------------------------------------------------------------------

export class CScoutCodeLensProvider implements vscode.CodeLensProvider {
    private _emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._emitter.event;
    private filesCache: CScoutFile[] | null = null;

    constructor(private getClient: () => CScoutClient | undefined, private channel: vscode.OutputChannel) { }

    refresh(): void {
        this.filesCache = null;
        this._emitter.fire();
    }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (token.isCancellationRequested) return [];
        const client = this.getClient();
        if (!client) return [];

        if (await delayUntilCancelled(150, token)) return [];

        try {
            if (!this.filesCache) {
                this.filesCache = await client.getFiles();
            }

            // Find FID for the current document
            const fsPathLower = document.uri.fsPath.toLowerCase();
            const file = this.filesCache.find(f => toEditorPath(f.NAME).toLowerCase() === fsPathLower);
            if (!file) return [];

            const detail = await client.getFileDetail(file.FID);
            const lenses: vscode.CodeLens[] = [];

            for (const fn of detail.functions) {
                if (fn.LNUM === null) continue;

                const line = fn.LNUM - 1;
                if (line < 0 || line >= document.lineCount) continue;

                const lineText = document.lineAt(line).text;
                const idx = lineText.indexOf(fn.NAME);
                const charStart = idx >= 0 ? idx : 0;
                const range = new vscode.Range(line, charStart, line, charStart + fn.NAME.length);

                const fanin = fn.FANIN ?? 0;
                const fanout = fn.FANOUT ?? 0;
                const callerLabel = fanin === 1 ? '1 caller' : `${fanin} callers`;
                const calleeLabel = fanout === 1 ? '1 callee' : `${fanout} callees`;

                lenses.push(
                    new vscode.CodeLens(range, {
                        title: `${callerLabel}, ${calleeLabel}`,
                        command: 'cscout.showCallGraph',
                        arguments: [fn.ID, true, fn.NAME]
                    })
                );
            }
            return lenses;
        } catch (err) {
            this.channel.appendLine(`Failed to provide code lenses: ${friendlyErrorMessage(err)}`);
            return [];
        }
    }
}

// -----------------------------------------------------------------------
// activate()
// -----------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
    const channel = vscode.window.createOutputChannel('CScout');
    context.subscriptions.push(channel);

    const settings = loadSettings();

    let currentState: CScoutState = 'stopped';
    const stateContextKey = 'cscout.state';
    let isAnalysisStale = false;
    let isNotificationDismissed = false;
    let fileChangeTimeout: NodeJS.Timeout | undefined;

    // TODO: this cscout.state context key isn't used by anything right
    // now. The original plan was a package.json "when" clause to
    // show/hide the Stop button based on state, but that ended up being
    // built a different way instead (ActionTreeProvider tracks its own
    // state and returns a different button list directly). Delete this
    // if a when-clause feature off cscout.state isn't planned, otherwise
    // keep it for that.
    void vscode.commands.executeCommand('setContext', stateContextKey, currentState);

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBar);

    const diagnostics = vscode.languages.createDiagnosticCollection('cscout');
    context.subscriptions.push(diagnostics);

    // Maps editor positions to identifiers for hover, navigation and
    // rename. Created before the lifecycle because every state change
    // below resets it.
    const resolver = new IdentifierResolver(() => lifecycle.getClient(), channel);
    context.subscriptions.push(resolver);

    const lifecycle = new CScoutLifecycle(settings, channel, {
        onStateChange: (state, detail) => {
            currentState = state;
            resolver.reset();
            void vscode.commands.executeCommand('setContext', stateContextKey, state);
            if (state !== 'ready') {
                isAnalysisStale = false;
                isNotificationDismissed = false;
                if (fileChangeTimeout) {
                    clearTimeout(fileChangeTimeout);
                    fileChangeTimeout = undefined;
                }
            }
            updateStatusBar(statusBar, state, detail, lifecycle, isAnalysisStale);
            identifierProvider.refresh();
            fileProvider.refresh();
            functionProvider.refresh();
            fileDepsProvider.refresh();
            actionProvider.setState(state);
            codeLensProvider.refresh();
            
            if (state === 'ready') {
                const client = lifecycle.getClient();
                if (client) {
                    void refreshDiagnostics(client, diagnostics);
                }
                for (const editor of vscode.window.visibleTextEditors) {
                    resolver.prefetch(editor.document);
                }
            } else {
                diagnostics.clear();
            }
        },
        onReady: async (build) => {
            void detectCScoutVersion(settings.cscoutBinaryPath);
            channel.appendLine(`Ready.  ${build.fileCount} files, workspace: ${build.projectName}`);
            const client = lifecycle.getClient();
            if (client) {
                await refreshDiagnostics(client, diagnostics);
                try {
                    const [fileAttrs, idAttrs] = await Promise.all([
                        client.getFileAttributes(),
                        client.getIdentifierAttributes(),
                    ]);
                    metricDescriptions = Object.fromEntries(fileAttrs.map(a => [a.id, a.name]));
                    identifierAttributes = idAttrs;
                } catch {
                    // Non-fatal: fall back to static METRIC_DESCRIPTIONS
                }
            }
        },
        onError: (message) => {
            vscode.window
                .showErrorMessage(`CScout: ${message}`, 'View Output')
                .then((choice) => {
                    if (choice === 'View Output') {
                        channel.show();
                    }
                });
        },
        onProgress: (message) => channel.appendLine(message),
    });
    context.subscriptions.push({ dispose: () => lifecycle.dispose() });

    // Watches a wider set of file types than the structural watcher in
    // lifecycle.ts (CScoutLifecycle.setupFileWatcher), and reacts to
    // edits too, not just files being added or removed. Doesn't prompt
    // right away, just marks the status bar stale, then after a 10s
    // debounce (so it doesn't nag mid-edit) suggests re-analyzing.
    const fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/*.{c,h,cpp,hpp,cc,y}');
    context.subscriptions.push(fileSystemWatcher);

    const handleFileChange = () => {
        if (currentState !== 'ready') return;
        isAnalysisStale = true;
        updateStatusBar(statusBar, currentState, undefined, lifecycle, isAnalysisStale);

        if (isNotificationDismissed) return;

        if (fileChangeTimeout) {
            clearTimeout(fileChangeTimeout);
        }
        fileChangeTimeout = setTimeout(async () => {
            if (currentState !== 'ready' || isNotificationDismissed) return;

            const selection = await vscode.window.showInformationMessage(
                'CScout: Source files have changed. The active analysis database may be stale.',
                'Re-analyze',
                'Ignore'
            );

            if (selection === 'Re-analyze') {
                await vscode.commands.executeCommand('cscout.reanalyze');
            } else if (selection === 'Ignore') {
                isNotificationDismissed = true;
            }
        }, 10000);
    };

    fileSystemWatcher.onDidChange(handleFileChange);
    fileSystemWatcher.onDidCreate(handleFileChange);
    fileSystemWatcher.onDidDelete(handleFileChange);

    const identifierProvider = new IdentifierTreeProvider(() => lifecycle.getClient(), context);
    const fileProvider = new FileTreeProvider(() => lifecycle.getClient(), context);
    const functionProvider = new FunctionTreeProvider(() => lifecycle.getClient(), context);
    const fileDepsProvider = new FileDepsTreeProvider(() => lifecycle.getClient(), context);
    const actionProvider = new ActionTreeProvider();
    actionProvider.setState(currentState);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('cscout.identifiers', identifierProvider),
        vscode.window.registerTreeDataProvider('cscout.files', fileProvider),
        vscode.window.registerTreeDataProvider('cscout.functions', functionProvider),
        vscode.window.registerTreeDataProvider('cscout.filedeps', fileDepsProvider),
        vscode.window.registerTreeDataProvider('cscout.actions', actionProvider)
    );

    // Editor providers.
    const clientAccessor = () => lifecycle.getClient();
    const codeLensProvider = new CScoutCodeLensProvider(clientAccessor, channel);
    const selector: vscode.DocumentSelector = [
        { language: 'c' },
        { language: 'cpp' }
    ];
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            selector,
            new CScoutHoverProvider(resolver, () => isAnalysisStale)
        ),
        vscode.languages.registerDefinitionProvider(
            selector,
            new CScoutDefinitionProvider(clientAccessor, resolver)
        ),
        vscode.languages.registerReferenceProvider(
            selector,
            new CScoutReferenceProvider(clientAccessor, resolver)
        ),
        vscode.languages.registerRenameProvider(
            selector,
            new CScoutRenameProvider(clientAccessor, resolver, channel)
        ),
        vscode.languages.registerCodeLensProvider(
            selector,
            codeLensProvider
        )
    );

    // Commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('cscout.start', async () => {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) {
                vscode.window.showErrorMessage('CScout: open a folder first.');
                return;
            }
            await lifecycle.start(ws.uri.fsPath);
        }),
        vscode.commands.registerCommand('cscout.stop', () => lifecycle.stop()),
        vscode.commands.registerCommand('cscout.reanalyze', async () => {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) return;
            await lifecycle.reanalyze(ws.uri.fsPath);
        }),
        vscode.commands.registerCommand('cscout.toggle', () => {
            if (currentState === 'ready' || currentState === 'analyzing' || currentState === 'indexing') {
                return lifecycle.stop();
            }
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) return;
            return lifecycle.start(ws.uri.fsPath);
        }),
        vscode.commands.registerCommand('cscout.refresh', () => {
            identifierProvider.refresh();
            fileProvider.refresh();
            functionProvider.refresh();
            fileDepsProvider.refresh();
            codeLensProvider.refresh();
            const client = lifecycle.getClient();
            if (client) {
                void refreshDiagnostics(client, diagnostics);
            }
        }),
        vscode.commands.registerCommand('cscout.showFileDep', async (graphType: string, writableOnly: boolean) => {
            const client = lifecycle.getClient();
            if (!client) return;
            const panel = vscode.window.createWebviewPanel(
                'cscoutFileDep',
                `File dependency: ${graphType}${writableOnly ? ' (writable)' : ''}`,
                vscode.ViewColumn.Beside,
                { enableScripts: true }
            );
            try {
                const path = `/filegraph/${graphType}${writableOnly ? '?writable=true' : ''}`;
                const html = await client.getRaw(path);
                panel.webview.html = makeGraphInteractive(html, panel.webview);
            } catch (err) {
                panel.webview.html = `<html><head>${getWebviewCsp(panel.webview)}</head><body>Error: ${escapeHtml(String(err))}</body></html>`;
            }
        }),
        vscode.commands.registerCommand('cscout.gotoIdentifier', async (eid: number) => {
            const client = lifecycle.getClient();
            if (!client) return;
            try {
                const detail = await client.getIdentifier(eid);
                const first = detail.locations.find((l) => l.LNUM !== null);
                if (!first) {
                    vscode.window.showInformationMessage(`No definition location for identifier ${eid}.`);
                    return;
                }
                const uri = vscode.Uri.file(toEditorPath(first.FILE));
                const doc = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(doc);
                const pos = new vscode.Position(Math.max(0, (first.LNUM || 1) - 1), 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not open identifier: ${friendlyErrorMessage(err)}`);
            }
        }),
        vscode.commands.registerCommand('cscout.openFunctionLocation', async (fn: CScoutFunction) => {
            if (!fn.FILE || fn.LNUM === null || fn.LNUM === undefined) {
                vscode.window.showInformationMessage(`No definition location for function ${fn.NAME}.`);
                return;
            }
            try {
                const uri = vscode.Uri.file(toEditorPath(fn.FILE));
                const doc = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(doc);
                const pos = new vscode.Position(Math.max(0, fn.LNUM - 1), 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not open function: ${friendlyErrorMessage(err)}`);
            }
        }),
        vscode.commands.registerCommand('cscout.openFile', async (filePath: string, line?: number) => {
            try {
                const uri = vscode.Uri.file(toEditorPath(filePath));
                const doc = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(doc);
                if (line !== undefined) {
                    const pos = new vscode.Position(Math.max(0, line - 1), 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Could not open file: ${friendlyErrorMessage(err)}`);
            }
        }),
        vscode.commands.registerCommand('cscout.showCallGraph', async (eidOrFnid?: number, isFnid: boolean = false, nameHint?: string) => {
            const client = lifecycle.getClient();
            if (!client) return;
            const target = eidOrFnid ?? (await promptForFunctionEid(client));
            if (target === undefined) return;
            await showCallGraph(context, client, target, isFnid, nameHint);
        }),
        vscode.commands.registerCommand('cscout.showFunctionMetrics', async (fnid?: number) => {
            const client = lifecycle.getClient();
            if (!client) return;
            const target = fnid ?? (await promptForFunctionEid(client));
            if (target === undefined) return;
            await showFunctionMetrics(client, target);
        }),
        vscode.commands.registerCommand('cscout.showFileMetricsAggregate', async () => {
            const client = lifecycle.getClient();
            if (!client) return;
            const metrics = await client.getFilemetricsAggregate();
            const files = await client.getFiles();
            showFileMetricsAggregatePanel(metrics, files);
        }),
        vscode.commands.registerCommand('cscout.showIdentifierStats', async () => {
            const client = lifecycle.getClient();
            if (!client) return;
            const stats = await client.getIdentifierStats();
            showIdentifierStatsPanel(stats);
        }),
        vscode.commands.registerCommand('cscout.showFunMetricsAggregate', async () => {
            const client = lifecycle.getClient();
            if (!client) return;
            const metrics = await client.getFunmetricsAggregate();
            showFunMetricsAggregatePanel(metrics);
        }),
        vscode.commands.registerCommand('cscout.inspectFile', async (nodeOrFid?: any) => {
            const client = lifecycle.getClient();
            if (!client) return;
            let fid: number | undefined;
            if (typeof nodeOrFid === 'number') {
                // called programmatically with a raw FID
                fid = nodeOrFid;
            } else if (nodeOrFid?.kind === 'file') {
                // VS Code passes the raw Node object for context-menu commands
                fid = nodeOrFid.file?.FID;
            } else if (typeof nodeOrFid?.id === 'string' && nodeOrFid.id.startsWith('file-')) {
                // fallback: TreeItem id if somehow passed
                fid = parseInt(nodeOrFid.id.replace('file-', ''));
            }
            if (fid === undefined) return;
            const detail = await client.getFileDetail(fid);
            showFileDetailPanel(detail);
        }),
        vscode.commands.registerCommand('cscout.showWalkthrough', () => {
            showWalkthrough();
        }),
        vscode.commands.registerCommand('cscout.verifySetup', async () => {
            const settings = vscode.workspace.getConfiguration('cscout');
            const binaryPath = settings.get<string>('binaryPath', 'cscout');
            const cscocoPyPath = settings.get<string>('cscocoPyPath', 'cscoco.py');
            const csapiPyPath = settings.get<string>('csapiPyPath', '');
            const csmakePath = settings.get<string>('csmakePath', 'csmake');
            const pythonPath = settings.get<string>('pythonPath', 'python3');

            const checks: { name: string; path: string }[] = [
                { name: 'CScout binary', path: binaryPath },
                { name: 'cscoco.py', path: cscocoPyPath },
                { name: 'csapi.py', path: csapiPyPath },
                { name: 'csmake', path: csmakePath },
                { name: 'Python', path: pythonPath },
            ];

            const results: string[] = [];
            for (const check of checks) {
                if (!check.path) {
                    results.push(`○ ${check.name}: not set`);
                    continue;
                }
                try {
                    await checkDependency(check.path, `${check.name} not found`, commandRunsInWsl(check.path));
                    results.push(`✓ ${check.name}: found (${check.path})`);
                } catch {
                    results.push(`✗ ${check.name}: NOT FOUND (${check.path})`);
                }
            }

            const panel = vscode.window.createOutputChannel('CScout Setup Check');
            panel.clear();
            panel.appendLine('CScout Setup Verification');
            panel.appendLine('');
            results.forEach(r => panel.appendLine(r));
            panel.show();
        }),
        vscode.commands.registerCommand('cscout.loadMore', async (node) => {
            // TODO: this calls all three providers' loadMore every time,
            // not just the one whose "Load more" row was actually clicked.
            // The node only carries a groupKey, and all three panels reuse
            // the same group keys (like "all"), so there is currently no
            // way to tell which panel the click actually came from. That
            // means clicking "Load more" in one panel can silently fetch
            // data and refresh the other two panels as well, even if the
            // user never opened them.
            // Suggested fix: tag each panel's load-more node with which
            // panel it came from (identifier, file, or function) when it
            // is created, then only call that one provider's loadMore here
            // instead of all three.
            await Promise.all([
                identifierProvider.loadMore(node),
                fileProvider.loadMore(node),
                functionProvider.loadMore(node),
            ]);
        }),
        vscode.commands.registerCommand('cscout.findReferences', async (eid?: number) => {
            const client = lifecycle.getClient();
            if (!client || eid === undefined) return;
            try {
                const detail = await client.getIdentifier(eid);
                const locs = detail.locations
                    .filter((l) => l.LNUM !== null)
                    .map(locationToVSCode);
                if (locs.length === 0) {
                    vscode.window.showInformationMessage(`No references found for identifier ${eid}.`);
                    return;
                }
                const first = locs[0];
                await vscode.commands.executeCommand('editor.action.showReferences', first.uri, first.range.start, locs);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not find references: ${friendlyErrorMessage(err)}`);
            }
        }),
        vscode.commands.registerCommand('cscout.inspect', async (eidOrArgs?: number | [number]) => {
            const client = lifecycle.getClient();
            if (!client || eidOrArgs === undefined) return;
            await showInspect(client, eidOrArgs);
        }),
        vscode.commands.registerCommand('cscout.rename', async (posObj?: { line: number; character: number }) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            if (posObj) {
                const pos = new vscode.Position(posObj.line, posObj.character);
                editor.selection = new vscode.Selection(pos, pos);
            }
            await vscode.commands.executeCommand('editor.action.rename');
        })
    );

    // Status bar starts up idle.
    updateStatusBar(statusBar, 'stopped', undefined, lifecycle, false);
    statusBar.show();

    // First-activation walkthrough.
    if (!context.globalState.get<boolean>(CSCOUT_KEY_FIRST_ACTIVATION)) {
        void context.globalState.update(CSCOUT_KEY_FIRST_ACTIVATION, true);
        showWalkthrough();
    }

    // Autostart if requested.
    if (settings.autoStart) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
            void lifecycle.start(ws.uri.fsPath);
        }
    }
}

// -----------------------------------------------------------------------
// Status bar
// -----------------------------------------------------------------------

function updateStatusBar(
    item: vscode.StatusBarItem,
    state: CScoutState,
    detail: string | undefined,
    lifecycle: CScoutLifecycle,
    isStale: boolean
): void {
    switch (state) {
        case 'stopped':
            item.text = '$(play) CScout';
            item.tooltip = 'Start CScout analysis';
            item.command = 'cscout.start';
            break;
        case 'analyzing':
            item.text = '$(sync~spin) CScout: Analyzing';
            item.tooltip = (detail || 'Running CScout analysis...') + ' - click to stop';
            item.command = 'cscout.stop';
            break;
        case 'indexing':
            item.text = '$(sync~spin) CScout: Building indexes';
            item.tooltip = 'csapi is building search indexes... - click to stop';
            item.command = 'cscout.stop';
            break;
        case 'ready': {
            const build = lifecycle.getBuildResult();
            const versionSuffix = cscoutVersion ? ` (v${cscoutVersion})` : '';
            if (isStale) {
                item.text = `$(warning) CScout (stale)${build ? ` · ${build.fileCount} files` : ''}`;
                item.tooltip = `CScout${versionSuffix} ready (source files changed) - click to stop`;
            } else {
                item.text = `$(check) CScout${build ? ` · ${build.fileCount} files` : ''}`;
                item.tooltip = `CScout${versionSuffix} ready - click to stop`;
            }
            item.command = 'cscout.stop';
            break;
        }
        case 'error':
            item.text = '$(error) CScout';
            item.tooltip = detail || 'CScout encountered an error';
            item.command = 'cscout.start';
            break;
    }
}

// -----------------------------------------------------------------------
// Shared webview helpers for nonce/CSP setup and the HTML/JS used by the
// graph and metrics panels below
// -----------------------------------------------------------------------

async function promptForFunctionEid(client: CScoutClient): Promise<number | undefined> {
    const name = await vscode.window.showInputBox({
        title: 'Function name',
        placeHolder: 'e.g. main',
    });
    if (!name) return undefined;
    const results = await client.getIdentifiers({ name, query: 'functions', limit: 20 });
    if (results.length === 0) {
        vscode.window.showInformationMessage(`No function named "${name}" found.`);
        return undefined;
    }
    if (results.length === 1) return results[0].EID;
    const pick = await vscode.window.showQuickPick(
        results.map((r) => ({ label: r.NAME, description: `EID ${r.EID}`, value: r.EID })),
        { title: 'Select function' }
    );
    return pick?.value;
}

const SORTABLE_TABLE_SCRIPT = `
const vscode = acquireVsCodeApi();
let sortCol=0, sortAsc=false;
function sortBy(col){
    if(sortCol===col){sortAsc=!sortAsc;}else{sortCol=col;sortAsc=false;}
    const tb=document.getElementById('tb');
    const rows=[...tb.rows];
    rows.sort((a,b)=>{
        const av=a.cells[col]?.dataset.val??'';
        const bv=b.cells[col]?.dataset.val??'';
        const an=parseFloat(av), bn=parseFloat(bv);
        if(!isNaN(an)&&!isNaN(bn)) return sortAsc?an-bn:bn-an;
        return sortAsc?av.localeCompare(bv):bv.localeCompare(av);
    });
    rows.forEach(r=>tb.appendChild(r));
}`;

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function getWebviewCsp(webview: vscode.Webview, nonce?: string): string {
    const scriptSrc = nonce ? `'nonce-${nonce}'` : `'none'`;
    // This CSP blocks everything by default. Scripts only run if they carry this
    // exact nonce. Styles can come from the webview's own origin or be inline.
    // Images can come from the webview's own origin, data: URIs, or https:.
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${scriptSrc};">`;
}

function makeGraphInteractive(html: string, webview: vscode.Webview, showAll?: boolean): string {
    const nonce = getNonce();
    const hasToggle = showAll !== undefined;
    const toggleHtml = hasToggle ? `
        <div id="graphControls" style="position: fixed; top: 10px; left: 10px; z-index: 1000; background: var(--vscode-editor-background); padding: 5px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 3px;">
            <label style="cursor: pointer; display: flex; align-items: center; gap: 5px;">
                <input type="checkbox" id="showAll" ${showAll ? 'checked' : ''}> Show file-scoped functions
            </label>
        </div>` : '';
    
    return html
        .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${getWebviewCsp(webview, nonce)}`)
        .replace('svg { max-width: 100%; height: auto; }', `
            svg {
                transform-origin: 0 0;
                cursor: grab;
                user-select: none;
                max-width: none !important;
                height: auto !important;
            }
            svg:active {
                cursor: grabbing;
            }
        `)
        .replace('</style>', `
            svg {
                transform-origin: 0 0;
                cursor: grab;
                user-select: none;
                max-width: none !important;
                height: auto !important;
            }
            svg:active {
                cursor: grabbing;
            }
            svg > polygon:first-child,
            svg > rect:first-child { fill: transparent !important; }
            body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
            
            /* Theme-adaptive edges, arrowheads, and labels for Light & Dark VS Code themes */
            .edge path {
                stroke: var(--vscode-editor-foreground) !important;
                opacity: 0.85;
            }
            .edge polygon {
                stroke: var(--vscode-editor-foreground) !important;
                fill: var(--vscode-editor-foreground) !important;
                opacity: 0.85;
            }
            .edge text {
                fill: var(--vscode-editor-foreground) !important;
            }
        </style>`)
        .replace('</body>', `
        ${toggleHtml}
        <script nonce="${nonce}">
            ${hasToggle ? `
            const vscode = acquireVsCodeApi();
            document.getElementById('showAll')?.addEventListener('change', (e) => {
                vscode.postMessage({ command: 'toggleAll', value: e.target.checked });
            });
            ` : ''}
            let scale = 1, x = 0, y = 0, isDragging = false, startX, startY;
            const svg = document.querySelector('svg');
            // The pan/zoom handlers below sit on window, so they also see clicks
            // that land on the controls overlay. Without this guard the
            // pointerdown handler calls setPointerCapture on the SVG, which
            // steals the rest of the click away from the checkbox, so the
            // checkbox never toggles and never fires its change event.
            const inControls = (e) => !!(e.target && e.target.closest && e.target.closest('#graphControls'));
            if (svg) {
                window.addEventListener('wheel', (e) => {
                    if (inControls(e)) return;
                    e.preventDefault();
                    const zoom = e.deltaY < 0 ? 1.15 : 0.85;
                    const rect = svg.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    x -= mouseX * (zoom - 1);
                    y -= mouseY * (zoom - 1);
                    scale *= zoom;
                    svg.style.transform = \`translate(\${x}px, \${y}px) scale(\${scale})\`;
                }, { passive: false });

                window.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0) return;
                    if (inControls(e)) return;
                    isDragging = true;
                    startX = e.clientX - x;
                    startY = e.clientY - y;
                    svg.setPointerCapture(e.pointerId);
                });

                window.addEventListener('pointermove', (e) => {
                    if (!isDragging) return;
                    x = e.clientX - startX;
                    y = e.clientY - startY;
                    svg.style.transform = \`translate(\${x}px, \${y}px) scale(\${scale})\`;
                });

                window.addEventListener('pointerup', (e) => {
                    if (isDragging) {
                        isDragging = false;
                        svg.releasePointerCapture(e.pointerId);
                    }
                });

                window.addEventListener('pointercancel', (e) => {
                    if (isDragging) {
                        isDragging = false;
                        svg.releasePointerCapture(e.pointerId);
                    }
                });
            }
        </script>
        </body>`);
}

// -----------------------------------------------------------------------
// Call graph, include graph, function metrics and inspect webviews
// -----------------------------------------------------------------------

async function showCallGraph(
    context: vscode.ExtensionContext,
    client: CScoutClient,
    eidOrFnid: number,
    isFnid: boolean = false,
    nameHint?: string
): Promise<void> {
    let fnid: number;
    let fnName: string;

    if (isFnid) {
        // Called from CodeLens with FUNCTIONS.ID directly.
        fnid = eidOrFnid;
        fnName = nameHint ?? `function ${fnid}`;
    } else {
        // Called with an EID: find the function it names.
        const data = await client.getIdentifierHover(eidOrFnid);
        fnName = data.identifier.NAME;
        const pick = pickFunction(data.functions, undefined);
        let fn: CScoutHoverFunction | undefined;
        if (pick.kind === 'one') {
            fn = pick.fn;
        } else if (pick.kind === 'ambiguous') {
            const chosen = await vscode.window.showQuickPick(
                pick.definitions.map((f) => ({
                    label: fnName,
                    description: `${path.basename(toEditorPath(f.DEF_FILE ?? ''))}:${f.DEF_LNUM ?? '?'}`,
                    detail: f.DEF_FILE ? toEditorPath(f.DEF_FILE) : undefined,
                    fn: f,
                })),
                { title: `${fnName} is defined in ${pick.definitions.length} places` }
            );
            if (!chosen) return;
            fn = chosen.fn;
        }
        if (!fn) {
            const p = vscode.window.createWebviewPanel(
                'cscoutCallGraph',
                `Call graph: ${fnName}`,
                vscode.ViewColumn.Beside,
                { enableScripts: true }
            );
            p.webview.html = `<!doctype html><html><head>${getWebviewCsp(p.webview)}</head><body style="font-family:sans-serif;padding:2em">
                <p>No call graph available for <strong>${escapeHtml(fnName)}</strong> - not tracked as a callable function.</p>
                </body></html>`;
            return;
        }
        fnid = fn.ID;
    }

    try {
        const pythonPath = vscode.workspace.getConfiguration('cscout').get<string>('pythonPath', 'python3');
        await checkDependency('dot', 'dot not found', commandRunsInWsl(pythonPath));
    } catch {
        vscode.window.showWarningMessage('Graphviz (dot) was not found in your system PATH. Call graph generation may fail or display empty. Please install Graphviz.');
    }

    const panel = vscode.window.createWebviewPanel(
        'cscoutCallGraph',
        `Call graph: ${fnName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    let showAll = false;

    const renderGraph = async () => {
        try {
            const svg = await client.getRaw(`/callgraph?fnid=${fnid}&all=${showAll ? 1 : 0}`);
            panel.webview.html = makeGraphInteractive(svg, panel.webview, showAll);
        } catch (err) {
            panel.webview.html = `<!doctype html><html><head>${getWebviewCsp(panel.webview)}</head><body style="font-family:sans-serif;padding:2em">
                <p>Error generating call graph: ${escapeHtml(String(err))}</p>
                </body></html>`;
        }
    };

    panel.webview.onDidReceiveMessage(message => {
        if (message.command === 'toggleAll') {
            showAll = message.value;
            renderGraph();
        }
    });

    renderGraph();
}

async function showFunctionMetrics(
    client: CScoutClient,
    fnid: number
): Promise<void> {
    const metrics = await client.getFunmetrics(fnid);
    const panel = vscode.window.createWebviewPanel(
        'cscoutFuncMetrics',
        `Function metrics`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );
    const rows = metrics
        .map((m) => {
            const entries = Object.entries(m)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
                .join('');
            return `<h2>${m.PRECPP ? 'Pre-preprocessor' : 'Post-preprocessor'}</h2><table>${entries}</table>`;
        })
        .join('');
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
${getWebviewCsp(panel.webview)}
<style>
body { font-family: var(--vscode-font-family); padding: 1em; }
table { border-collapse: collapse; width: 100%; }
td { padding: .25em .75em; border-bottom: 1px solid var(--vscode-panel-border); }
td:first-child { color: var(--vscode-descriptionForeground); }
</style></head><body>${rows}</body></html>`;
}

async function showInspect(
    client: CScoutClient,
    eidOrArgs: number | [number]
): Promise<void> {
    const eid = Array.isArray(eidOrArgs) ? eidOrArgs[0] : eidOrArgs;
    const panel = vscode.window.createWebviewPanel(
        'cscoutInspect',
        `Inspect: Identifier`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );
    try {
        const detail = await client.getIdentifierDetail(eid);
        if (!detail || !detail.identifier) {
            panel.webview.html = `<!doctype html><html><head>${getWebviewCsp(panel.webview)}</head><body style="font-family:sans-serif;padding:2em"><p>Identifier ${eid} not found.</p></body></html>`;
            return;
        }
        panel.title = `Inspect: ${detail.identifier.NAME}`;
        panel.webview.html = renderInspectHtml(detail, panel.webview);
    } catch (err) {
        panel.webview.html = `<!doctype html><html><head>${getWebviewCsp(panel.webview)}</head><body style="font-family:sans-serif;padding:2em"><p>Error loading inspect data: ${escapeHtml(String(err))}</p></body></html>`;
    }
}

// Attribute and metric metadata fetched from the API on connect.
// Keys are DB column names (e.g. "NCHAR"), values are display names.
let metricDescriptions: Record<string, string> = {};
let identifierAttributes: { id: string; name: string }[] = [];

function getMetricDescriptions(): Record<string, string> {
    return Object.keys(metricDescriptions).length > 0
        ? metricDescriptions
        : METRIC_DESCRIPTIONS;
}

const METRIC_DESCRIPTIONS: Record<string, string> = {
    NCHAR: "Number of characters",
    NCCOMMENT: "Number of comment characters",
    NSPACE: "Number of space characters",
    NLCOMMENT: "Number of line comments",
    NBCOMMENT: "Number of block comments",
    NLINE: "Number of lines",
    MAXLINELEN: "Maximum number of characters in a line",
    MAXSTMTLEN: "Maximum number of tokens in a statement",
    MAXSTMTNEST: "Maximum level of statement nesting",
    MAXBRACENEST: "Maximum level of brace nesting",
    MAXBRACKNEST: "Maximum level of bracket nesting",
    BRACENEST: "Dangling brace nesting",
    BRACKNEST: "Dangling bracket nesting",
    NULINE: "Number of unprocessed lines",
    NTOKEN: "Number of tokens",
    NPPDIRECTIVE: "Number of C preprocessor directives",
    NPPCOND: "Number of processed C preprocessor conditionals (ifdef, if, elif)",
    NPPFMACRO: "Number of defined C preprocessor function-like macros",
    NPPOMACRO: "Number of defined C preprocessor object-like macros",
    NPPCONCATOP: "Number of token concatenation operators (##)",
    NPPSTRINGOP: "Number of token stringification operators (#)",
    NSTMT: "Number of statements or declarations",
    NOP: "Number of operators",
    NUOP: "Number of unique operators",
    NNCONST: "Number of numeric constants",
    NCLIT: "Number of character literals",
    NSTRING: "Number of character strings",
    NIF: "Number of if statements",
    NELSE: "Number of else clauses",
    NSWITCH: "Number of switch statements",
    NCASE: "Number of case labels",
    NDEFAULT: "Number of default labels",
    NBREAK: "Number of break statements",
    NFOR: "Number of for statements",
    NWHILE: "Number of while statements",
    NDO: "Number of do statements",
    NCONTINUE: "Number of continue statements",
    NGOTO: "Number of goto statements",
    NRETURN: "Number of return statements",
    NASM: "Number of assembly statements",
    NTYPEOF: "Number of typeof operators",
    NPID: "Number of project-scope identifiers",
    NFID: "Number of file-scope (static) identifiers",
    NMID: "Number of macro identifiers",
    NID: "Total number of object and object-like identifiers",
    NUPID: "Number of unique project-scope identifiers",
    NUFID: "Number of unique file-scope (static) identifiers",
    NUMID: "Number of unique macro identifiers",
    NUID: "Number of unique object and object-like identifiers",
    NLABEL: "Number of goto labels",
    NMACROEXPANDTOKEN: "Tokens added by macro expansion",
    NMPARAM: "Number of macro parameters",
    NEPARAM: "Number of empty macro parameters",
    FANIN: "Fan-in (number of calling functions)",
    FANOUT: "Fan-out (number of called functions)",
    CCYCL1: "Cyclomatic complexity (control flow only)",
    CCYCL2: "Cyclomatic complexity (including logical operators)",
    CCYCL3: "Cyclomatic complexity (modified, switch counted once)",
    CSTRUC: "Structure complexity (Henry-Kafura)",
    CHAL: "Halstead complexity",
    IFLOW: "Information flow complexity",
    NFPARAM: "Number of function parameters",
    NGNSOC: "Number of global non-static operands called",
};

function renderInspectHtml(detail: import('./cscoutClient').CScoutIdentifierDetail, webview: vscode.Webview): string {
    const id = detail.identifier;

    const bool = (v: number) => v ? '✓ Yes' : '-';

    const attrSource = identifierAttributes.length > 0
        ? identifierAttributes
        : [
            {id: 'READONLY', name: 'Read-only'},
            {id: 'SUETAG', name: 'Tag for struct/union/enum'},
            {id: 'SUMEMBER', name: 'Member of struct/union'},
            {id: 'LABEL', name: 'Label'},
            {id: 'ORDINARY', name: 'Ordinary identifier'},
            {id: 'MACRO', name: 'Macro'},
            {id: 'UNDEFMACRO', name: 'Undefined macro'},
            {id: 'UNDEFEDMACRO', name: 'Undefed macro'},
            {id: 'REDEFEDSAMEMACRO', name: 'Macro redefined with same value'},
            {id: 'REDEFEDDIFFMACRO', name: 'Macro redefined with different value'},
            {id: 'MACROARG', name: 'Macro argument'},
            {id: 'CSCOPE', name: 'File scope'},
            {id: 'LSCOPE', name: 'Project scope'},
            {id: 'TYPEDEF', name: 'Typedef'},
            {id: 'ENUM', name: 'Enumeration constant'},
            {id: 'YACC', name: 'Yacc identifier'},
            {id: 'FUN', name: 'Function'}
        ];

    const attrs = attrSource.map(a => [a.name, bool((id as any)[a.id])]);
    attrs.push(
        ['Can be replaced by C constant', bool(id.DEFCCONSTVAL || id.EXPCCONSTVAL)],
        ['Value defined as C compile-time constant', bool(id.DEFCCONSTVAL)],
        ['Value expanded as C compile-time constant', bool(id.EXPCCONSTVAL)]
    );

    const attrsHtml = attrs
        .map(([k, v]) => `<tr><td>${escapeHtml(String(k))}</td><td>${v}</td></tr>`)
        .join('');

    const projects = detail.projects ?? [];
    const depFiles = detail.dependent_files ?? [];

    const projectsHtml = projects.length
        ? projects.map(p => `<li>${escapeHtml(p.NAME)}</li>`).join('')
        : '<li>-</li>';

    const filesHtml = depFiles.length
        ? depFiles.map(f =>
            `<tr><td>${escapeHtml(f.NAME)}</td><td>${f.RO ? '🔒' : '✏️'}</td></tr>`
        ).join('')
        : '<tr><td colspan="2">-</td></tr>';

    const fnSection = detail.function_detail ? (() => {
        const fn = detail.function_detail!;
        const defHtml = fn.definition
            ? (() => {
                const defLoc = detail.locations.find(l => l.LNUM !== null && l.RO === 0) ?? detail.locations.find(l => l.LNUM !== null);
                const locStr = defLoc
                    ? `${escapeHtml(defLoc.FILE)} (line ${defLoc.LNUM})`
                    : `${escapeHtml(fn.definition.FILE)} (offset ${fn.definition.FOFFSETBEGIN})`;
                return `<p><strong>Defined in:</strong> ${locStr}</p>`;
            })()
            : '<p>No definition found</p>';

        const metrics = fn.metrics ?? [];
        const metricsHtml = (() => {
            if (!metrics.length) return '';
            const pre: any = metrics.find((m: any) => m.PRECPP === 1) ?? {};
            const post: any = metrics.find((m: any) => m.PRECPP === 0) ?? {};
            const keys = Object.keys(getMetricDescriptions());
            const rows = keys
                .filter(k => (pre[k] !== null && pre[k] !== undefined) || (post[k] !== null && post[k] !== undefined))
                .map(k => {
                    const preVal = pre[k] !== null && pre[k] !== undefined ? escapeHtml(String(pre[k])) : '-';
                    const postVal = post[k] !== null && post[k] !== undefined ? escapeHtml(String(post[k])) : '-';
                    return `<tr><td>${escapeHtml(getMetricDescriptions()[k])}</td><td style="text-align:right">${preVal}</td><td style="text-align:right">${postVal}</td></tr>`;
                }).join('');
            return `<details><summary>Metrics (Pre-cpp / Post-cpp)</summary><table>
                <tr><th style="text-align:left">Description</th><th style="text-align:right">Pre-cpp Value</th><th style="text-align:right">Post-cpp Value</th></tr>
                ${rows}
            </table></details>`;
        })();

        return `
        <section>
            <h2>Function Details</h2>
            ${defHtml}
            <p><strong>Calls directly:</strong> ${fn.callees_count} function(s)</p>
            <p><strong>Called directly by:</strong> ${fn.callers_count} function(s)</p>
            ${metricsHtml}
        </section>`;
    })() : '';

    return `<!doctype html>
<html><head><meta charset="utf-8">
${getWebviewCsp(webview)}
<style>
body { font-family: var(--vscode-font-family); padding: 1em; max-width: 900px; }
h1 { border-bottom: 2px solid var(--vscode-panel-border); padding-bottom: .4em; }
h2 { margin-top: 1.5em; color: var(--vscode-textLink-foreground); font-size: 1em; text-transform: uppercase; letter-spacing: .05em; }
section { margin-bottom: 1.5em; }
table { border-collapse: collapse; width: 100%; margin: .5em 0; }
td { padding: .3em .75em; border-bottom: 1px solid var(--vscode-panel-border); }
td:first-child { color: var(--vscode-descriptionForeground); width: 60%; }
ul { margin: .25em 0; padding-left: 1.5em; }
details { margin: .5em 0; }
summary { cursor: pointer; font-weight: bold; padding: .3em 0; }
.badge { display: inline-block; padding: .1em .4em; border-radius: 3px; font-size: .85em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: .3em; }
</style>
</head><body>
<h1>${escapeHtml(id.NAME)}</h1>

<section>
<p>
${describeIdKind(id).map(k => `<span class="badge"${k === 'Unused' ? ' style="background:var(--vscode-inputValidation-warningBackground)"' : ''}>${escapeHtml(k.toLowerCase())}</span>`).join('\n')}
</p>
<p><strong>Matches ${detail.occurrences ?? 0} occurrence(s)</strong></p>
${detail.locations && detail.locations.length
            ? `<details><summary>Locations</summary><ul>${detail.locations
                .filter(l => l.LNUM !== null)
                .map(l => `<li><a href="command:cscout.openFile?${encodeURIComponent(JSON.stringify([l.FILE, l.LNUM]))}">${escapeHtml(l.FILE)}:${l.LNUM}</a></li>`)
                .join('')
            }</ul></details>`
            : ''}
<p><strong>Appears in project(s):</strong></p>
<ul>${projectsHtml}</ul>
</section>

${fnSection}

<section>
<h2>Attributes</h2>
<table>${attrsHtml}</table>
</section>

<section>
<details style="margin-top: 1.5em;">
<summary><h2 style="display: inline; cursor: pointer; margin: 0; font-size: 1em; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-textLink-foreground);">Dependent Files (${depFiles.length})</h2></summary>
<table>
<tr><th>File</th><th></th></tr>
${filesHtml}
</table>
</details>
</section>

</body></html>`;
}

function showFileDetailPanel(
    detail: import('./cscoutClient').CScoutFileDetail
): void {
    const panel = vscode.window.createWebviewPanel(
        'cscoutFileDetail',
        `File: ${detail.file.NAME.split('/').pop()}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );
    const metrics = detail.metrics ?? {};
    const metricsRows = Object.keys(getMetricDescriptions())
        .filter(k => metrics[k] !== null && metrics[k] !== undefined)
        .map(k => `<tr><td>${escapeHtml(getMetricDescriptions()[k])}</td><td style="text-align:right">${escapeHtml(String(metrics[k]))}</td></tr>`)
        .join('');
    const functionsRows = detail.functions
        .map(f => `<tr><td>${escapeHtml(f.NAME)}</td><td style="text-align:right">${f.LNUM ?? '-'}</td><td style="text-align:right">${f.FANIN}</td><td style="text-align:right">${f.FANOUT ?? '-'}</td><td style="text-align:right">${f.CCYCL1 ?? '-'}</td></tr>`)
        .join('');
    const includesRows = detail.includes
        .map(f => `<li>${escapeHtml(f.NAME)}</li>`)
        .join('');
    const includedByRows = detail.included_by
        .map(f => `<li>${escapeHtml(f.NAME)}</li>`)
        .join('');
    const listener = panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'open' && msg.file) {
            const uri = vscode.Uri.file(toEditorPath(msg.file));
            await vscode.window.showTextDocument(uri);
        }
    });
    panel.onDidDispose(() => listener.dispose());
    panel.webview.html = `<!doctype html><html><head>
${getWebviewCsp(panel.webview)}
<style>
        body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:1em}
        h1{font-size:1.2em;word-break:break-all}
        h2{font-size:1em;margin-top:1.5em;color:var(--vscode-textLink-foreground)}
        table{border-collapse:collapse;width:100%;margin-bottom:1em}
        th,td{padding:4px 8px;border:1px solid var(--vscode-panel-border)}
        th{background:var(--vscode-editor-background);text-align:left}
        tr:hover td{background:var(--vscode-list-hoverBackground)}
        td:last-child,td:nth-child(2),td:nth-child(3),td:nth-child(4){text-align:right}
        .badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:.85em;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);margin-right:4px}
        ul{margin:0;padding-left:1.5em}
        section{margin-bottom:1.5em}
    </style></head><body>
    <h1>${escapeHtml(detail.file.NAME)}</h1>
    <p>
        <span class="badge">${detail.file.RO ? 'read-only' : 'writable'}</span>
    </p>
    <section>
        <h2>Metrics</h2>
        <details><summary>Show metrics</summary>
        <table><tr><th>Description</th><th style="text-align:right">Value</th></tr>${metricsRows}</table>
        </details>
    </section>
    <section>
        <h2>Functions (${detail.functions.length})</h2>
        <table><tr><th>Name</th><th>Line</th><th>Fan-in</th><th>Fan-out</th><th>Complexity</th></tr>
        ${functionsRows}</table>
    </section>
    <section>
        <details>
            <summary><h2 style="display: inline; margin: 0;">Includes (${detail.includes.length})</h2></summary>
            <ul>${includesRows || '<li>-</li>'}</ul>
        </details>
    </section>
    <section>
        <details>
            <summary><h2 style="display: inline; margin: 0;">Included by (${detail.included_by.length})</h2></summary>
            <ul>${includedByRows || '<li>-</li>'}</ul>
        </details>
    </section>
    </body></html>`;
}

// One row per file metric, in the same order and with the same pre/post
// preprocessing flags CScout itself uses (cscout/src/metrics.cpp and
// cscout/src/filemetrics.cpp).
interface FileMetricSpec { key: string; label: string; pre: boolean; post: boolean; }

const FILE_METRIC_TABLE: FileMetricSpec[] = [
    { key: 'NCHAR', label: 'Number of characters', pre: true, post: false },
    { key: 'NCCOMMENT', label: 'Number of comment characters', pre: true, post: false },
    { key: 'NSPACE', label: 'Number of space characters', pre: true, post: false },
    { key: 'NLCOMMENT', label: 'Number of line comments', pre: true, post: false },
    { key: 'NBCOMMENT', label: 'Number of block comments', pre: true, post: false },
    { key: 'NLINE', label: 'Number of lines', pre: true, post: false },
    { key: 'MAXLINELEN', label: 'Maximum number of characters in a line', pre: true, post: false },
    { key: 'MAXSTMTLEN', label: 'Maximum number of tokens in a statement', pre: true, post: true },
    { key: 'MAXSTMTNEST', label: 'Maximum level of statement nesting', pre: false, post: true },
    { key: 'MAXBRACENEST', label: 'Maximum level of brace nesting', pre: true, post: true },
    { key: 'MAXBRACKNEST', label: 'Maximum level of bracket nesting', pre: true, post: true },
    { key: 'BRACENEST', label: 'Dangling brace nesting', pre: true, post: false },
    { key: 'BRACKNEST', label: 'Dangling bracket nesting', pre: true, post: false },
    { key: 'NULINE', label: 'Number of unprocessed lines', pre: true, post: false },
    { key: 'NPPDIRECTIVE', label: 'Number of C preprocessor directives', pre: true, post: false },
    { key: 'NPPCOND', label: 'Number of processed C preprocessor conditionals (ifdef, if, elif)', pre: true, post: false },
    { key: 'NPPFMACRO', label: 'Number of defined C preprocessor function-like macros', pre: true, post: false },
    { key: 'NPPOMACRO', label: 'Number of defined C preprocessor object-like macros', pre: true, post: false },
    { key: 'NTOKEN', label: 'Number of tokens', pre: true, post: true },
    { key: 'NSTMT', label: 'Number of statements or declarations', pre: true, post: true },
    { key: 'NOP', label: 'Number of operators', pre: true, post: true },
    { key: 'NUOP', label: 'Number of unique operators', pre: true, post: true },
    { key: 'NNCONST', label: 'Number of numeric constants', pre: true, post: true },
    { key: 'NCLIT', label: 'Number of character literals', pre: true, post: true },
    { key: 'NSTRING', label: 'Number of character strings', pre: true, post: true },
    { key: 'NPPCONCATOP', label: 'Number of token concatenation operators (##)', pre: true, post: false },
    { key: 'NPPSTRINGOP', label: 'Number of token stringification operators (#)', pre: true, post: false },
    { key: 'NIF', label: 'Number of if statements', pre: true, post: true },
    { key: 'NELSE', label: 'Number of else clauses', pre: true, post: true },
    { key: 'NSWITCH', label: 'Number of switch statements', pre: true, post: true },
    { key: 'NCASE', label: 'Number of case labels', pre: true, post: true },
    { key: 'NDEFAULT', label: 'Number of default labels', pre: true, post: true },
    { key: 'NBREAK', label: 'Number of break statements', pre: true, post: true },
    { key: 'NFOR', label: 'Number of for statements', pre: true, post: true },
    { key: 'NWHILE', label: 'Number of while statements', pre: true, post: true },
    { key: 'NDO', label: 'Number of do statements', pre: true, post: true },
    { key: 'NCONTINUE', label: 'Number of continue statements', pre: true, post: true },
    { key: 'NGOTO', label: 'Number of goto statements', pre: true, post: true },
    { key: 'NRETURN', label: 'Number of return statements', pre: true, post: true },
    { key: 'NASM', label: 'Number of assembly statements', pre: true, post: true },
    { key: 'NTYPEOF', label: 'Number of typeof operators', pre: true, post: true },
    { key: 'NPID', label: 'Number of project-scope identifiers', pre: true, post: true },
    { key: 'NFID', label: 'Number of file-scope (static) identifiers', pre: true, post: true },
    { key: 'NMID', label: 'Number of macro identifiers', pre: true, post: false },
    { key: 'NID', label: 'Total number of object and object-like identifiers', pre: true, post: true },
    { key: 'NUPID', label: 'Number of unique project-scope identifiers', pre: true, post: true },
    { key: 'NUFID', label: 'Number of unique file-scope (static) identifiers', pre: true, post: true },
    { key: 'NUMID', label: 'Number of unique macro identifiers', pre: true, post: false },
    { key: 'NUID', label: 'Number of unique object and object-like identifiers', pre: true, post: true },
    { key: 'NLABEL', label: 'Number of goto labels', pre: true, post: true },
    { key: 'NMACROEXPANDTOKEN', label: 'Tokens added by macro expansion', pre: true, post: false },
    { key: 'NCOPIES', label: 'Number of copies of the file', pre: true, post: false },
    { key: 'NINCFILE', label: 'Number of directly included files', pre: true, post: false },
    { key: 'NPFUNCTION', label: 'Number of defined project-scope functions', pre: false, post: true },
    { key: 'NFFUNCTION', label: 'Number of defined file-scope (static) functions', pre: false, post: true },
    { key: 'NPVAR', label: 'Number of defined project-scope variables', pre: false, post: true },
    { key: 'NFVAR', label: 'Number of defined file-scope (static) variables', pre: false, post: true },
    { key: 'NAGGREGATE', label: 'Number of complete aggregate (struct/union) declarations', pre: false, post: true },
    { key: 'NAMEMBER', label: 'Number of declared aggregate (struct/union) members', pre: false, post: true },
    { key: 'NENUM', label: 'Number of complete enumeration declarations', pre: false, post: true },
    { key: 'NEMEMBER', label: 'Number of declared enumeration elements', pre: false, post: true },
];

function showFileMetricsAggregatePanel(
    metrics: any[],
    files: any[]
): void {
    const panel = vscode.window.createWebviewPanel(
        'cscoutFileMetricsAggregate',
        'File Metrics Table',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    // Total, min, and max across a set of metric rows for one field.
    // Returns null if none of the rows had a value for that field.
    const aggregate = (rows: any[], key: string): { total: number; min: number; max: number } | null => {
        let total = 0, min = Infinity, max = -Infinity, any = false;
        for (const r of rows) {
            const v = r[key];
            if (v === null || v === undefined) continue;
            const n = Number(v);
            total += n;
            if (n < min) min = n;
            if (n > max) max = n;
            any = true;
        }
        return any ? { total, min, max } : null;
    };

    const naCells = '<td style="text-align:right">-</td>'.repeat(4);
    const numCells = (agg: { total: number; min: number; max: number } | null, fileCount: number): string => {
        if (!agg) return naCells;
        const avg = fileCount > 0 ? (agg.total / fileCount).toFixed(2) : '-';
        return `<td style="text-align:right">${agg.total}</td><td style="text-align:right">${agg.min}</td>`
            + `<td style="text-align:right">${agg.max}</td><td style="text-align:right">${avg}</td>`;
    };

    // Writable files first, then read-only, matching CScout's own file
    // metrics page (FileMetricsSummary::operator<<).
    const renderGroup = (title: string, roValue: number): string => {
        const groupFids = new Set(files.filter(f => f.RO === roValue).map(f => f.FID));
        const fileCount = groupFids.size;
        const groupMetrics = metrics.filter(m => groupFids.has(m.FID));
        const preRows = groupMetrics.filter(m => m.PRECPP === 1);
        const postRows = groupMetrics.filter(m => m.PRECPP === 0);

        const bodyRows = FILE_METRIC_TABLE.map(spec => {
            const preAgg = spec.pre ? aggregate(preRows, spec.key) : null;
            const postAgg = spec.post ? aggregate(postRows, spec.key) : null;
            return `<tr><td>${escapeHtml(spec.label)}</td>${numCells(preAgg, fileCount)}${numCells(postAgg, fileCount)}</tr>`;
        }).join('');

        return `
    <h2>${escapeHtml(title)} (${fileCount})</h2>
    <div style="overflow:auto;max-height:70vh;margin-bottom:2em">
    <table>
        <thead>
            <tr><th></th><th colspan="4" style="text-align:center">Pre-cpp</th><th colspan="4" style="text-align:center">Post-cpp</th></tr>
            <tr><th style="text-align:left">Metric</th><th>Total</th><th>Min</th><th>Max</th><th>Avg</th><th>Total</th><th>Min</th><th>Max</th><th>Avg</th></tr>
        </thead>
        <tbody>${bodyRows}</tbody>
    </table>
    </div>`;
    };

    const nonce = getNonce();
    panel.webview.html = `<!doctype html><html><head>
${getWebviewCsp(panel.webview, nonce)}
<style>
        body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:1em}
        table{border-collapse:collapse;width:100%}
        th,td{padding:4px 8px;border:1px solid var(--vscode-panel-border);white-space:nowrap;text-align:right}
        th{background:var(--vscode-editor-background);position:sticky;top:0;border-bottom:2px solid var(--vscode-panel-border)}
        td:first-child,th:first-child{text-align:left}
    </style></head><body>
    <h1>File Metrics</h1>
    ${renderGroup('Writable Files', 0)}
    ${renderGroup('Read-only Files', 1)}
    </body></html>`;
}

function showIdentifierStatsPanel(
    stats: { writable: CScoutIdentifierClassStat[]; readonly: CScoutIdentifierClassStat[] }
): void {
    const panel = vscode.window.createWebviewPanel(
        'cscoutIdentifierStats',
        'Identifier Statistics',
        vscode.ViewColumn.One,
        { enableScripts: false }
    );

    const fmt = (v: number | null): string => v === null ? '-' : String(Math.round(v * 1000) / 1000);

    const renderGroup = (title: string, rows: CScoutIdentifierClassStat[]): string => {
        const bodyRows = rows.map(r => `
            <tr>
                <td>${escapeHtml(r.class)}</td>
                <td style="text-align:right">${r.pre_cpp_total}</td>
                <td style="text-align:right">-</td>
                <td style="text-align:right">${r.distinct}</td>
                <td style="text-align:right">${fmt(r.avg_len)}</td>
                <td style="text-align:right">${fmt(r.min_len)}</td>
                <td style="text-align:right">${fmt(r.max_len)}</td>
            </tr>`).join('');
        return `
    <h2>${escapeHtml(title)}</h2>
    <div style="overflow:auto">
    <table>
        <thead>
            <tr>
                <th style="text-align:left">Identifier class</th>
                <th>Pre-cpp<br>total ids</th>
                <th>Post-cpp<br>total ids</th>
                <th>Distinct ids</th>
                <th>Avg len</th>
                <th>Min len</th>
                <th>Max len</th>
            </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
    </table>
    </div>`;
    };

    const nonce = getNonce();
    panel.webview.html = `<!doctype html><html><head>
${getWebviewCsp(panel.webview, nonce)}
<style>
        body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:1em}
        table{border-collapse:collapse;width:100%;margin-bottom:2em}
        th,td{padding:4px 8px;border:1px solid var(--vscode-panel-border);white-space:nowrap;text-align:right}
        th{background:var(--vscode-editor-background);border-bottom:2px solid var(--vscode-panel-border)}
        td:first-child,th:first-child{text-align:left}
    </style></head><body>
    <h1>Identifier Statistics</h1>
    ${renderGroup('Writable Identifiers', stats.writable)}
    ${renderGroup('Read-only Identifiers', stats.readonly)}
    </body></html>`;
}

// general-purpose metrics as FILE_METRIC_TABLE (they come from
// the same shared base class in CScout, cscout/src/metrics.cpp), plus
// the metrics that only apply to functions (cscout/src/funmetrics.cpp)
const FUN_METRIC_TABLE: FileMetricSpec[] = [
    { key: 'NCHAR', label: 'Number of characters', pre: true, post: false },
    { key: 'NCCOMMENT', label: 'Number of comment characters', pre: true, post: false },
    { key: 'NSPACE', label: 'Number of space characters', pre: true, post: false },
    { key: 'NLCOMMENT', label: 'Number of line comments', pre: true, post: false },
    { key: 'NBCOMMENT', label: 'Number of block comments', pre: true, post: false },
    { key: 'NLINE', label: 'Number of lines', pre: true, post: false },
    { key: 'MAXLINELEN', label: 'Maximum number of characters in a line', pre: true, post: false },
    { key: 'MAXSTMTLEN', label: 'Maximum number of tokens in a statement', pre: true, post: true },
    { key: 'MAXSTMTNEST', label: 'Maximum level of statement nesting', pre: false, post: true },
    { key: 'MAXBRACENEST', label: 'Maximum level of brace nesting', pre: true, post: true },
    { key: 'MAXBRACKNEST', label: 'Maximum level of bracket nesting', pre: true, post: true },
    { key: 'BRACENEST', label: 'Dangling brace nesting', pre: true, post: false },
    { key: 'BRACKNEST', label: 'Dangling bracket nesting', pre: true, post: false },
    { key: 'NULINE', label: 'Number of unprocessed lines', pre: true, post: false },
    { key: 'NPPDIRECTIVE', label: 'Number of C preprocessor directives', pre: true, post: false },
    { key: 'NPPCOND', label: 'Number of processed C preprocessor conditionals (ifdef, if, elif)', pre: true, post: false },
    { key: 'NPPFMACRO', label: 'Number of defined C preprocessor function-like macros', pre: true, post: false },
    { key: 'NPPOMACRO', label: 'Number of defined C preprocessor object-like macros', pre: true, post: false },
    { key: 'NTOKEN', label: 'Number of tokens', pre: true, post: true },
    { key: 'NSTMT', label: 'Number of statements or declarations', pre: true, post: true },
    { key: 'NOP', label: 'Number of operators', pre: true, post: true },
    { key: 'NUOP', label: 'Number of unique operators', pre: true, post: true },
    { key: 'NNCONST', label: 'Number of numeric constants', pre: true, post: true },
    { key: 'NCLIT', label: 'Number of character literals', pre: true, post: true },
    { key: 'NSTRING', label: 'Number of character strings', pre: true, post: true },
    { key: 'NPPCONCATOP', label: 'Number of token concatenation operators (##)', pre: true, post: false },
    { key: 'NPPSTRINGOP', label: 'Number of token stringification operators (#)', pre: true, post: false },
    { key: 'NIF', label: 'Number of if statements', pre: true, post: true },
    { key: 'NELSE', label: 'Number of else clauses', pre: true, post: true },
    { key: 'NSWITCH', label: 'Number of switch statements', pre: true, post: true },
    { key: 'NCASE', label: 'Number of case labels', pre: true, post: true },
    { key: 'NDEFAULT', label: 'Number of default labels', pre: true, post: true },
    { key: 'NBREAK', label: 'Number of break statements', pre: true, post: true },
    { key: 'NFOR', label: 'Number of for statements', pre: true, post: true },
    { key: 'NWHILE', label: 'Number of while statements', pre: true, post: true },
    { key: 'NDO', label: 'Number of do statements', pre: true, post: true },
    { key: 'NCONTINUE', label: 'Number of continue statements', pre: true, post: true },
    { key: 'NGOTO', label: 'Number of goto statements', pre: true, post: true },
    { key: 'NRETURN', label: 'Number of return statements', pre: true, post: true },
    { key: 'NASM', label: 'Number of assembly statements', pre: true, post: true },
    { key: 'NTYPEOF', label: 'Number of typeof operators', pre: true, post: true },
    { key: 'NPID', label: 'Number of project-scope identifiers', pre: true, post: true },
    { key: 'NFID', label: 'Number of file-scope (static) identifiers', pre: true, post: true },
    { key: 'NMID', label: 'Number of macro identifiers', pre: true, post: false },
    { key: 'NID', label: 'Total number of object and object-like identifiers', pre: true, post: true },
    { key: 'NUPID', label: 'Number of unique project-scope identifiers', pre: true, post: true },
    { key: 'NUFID', label: 'Number of unique file-scope (static) identifiers', pre: true, post: true },
    { key: 'NUMID', label: 'Number of unique macro identifiers', pre: true, post: false },
    { key: 'NUID', label: 'Number of unique object and object-like identifiers', pre: true, post: true },
    { key: 'NLABEL', label: 'Number of goto labels', pre: true, post: true },
    { key: 'NMACROEXPANDTOKEN', label: 'Tokens added by macro expansion', pre: true, post: false },
    { key: 'NGNSOC', label: "Number of global namespace occupants at function's top", pre: false, post: true },
    { key: 'NMPARAM', label: 'Number of parameters (for macros)', pre: true, post: false },
    { key: 'NFPARAM', label: 'Number of parameters (for functions)', pre: false, post: true },
    { key: 'NEPARAM', label: 'Number of passed non-expression macro parameters', pre: true, post: false },
    { key: 'FANIN', label: 'Fan-in (number of calling functions)', pre: false, post: true },
    { key: 'FANOUT', label: 'Fan-out (number of called functions)', pre: false, post: true },
    { key: 'CCYCL1', label: 'Cyclomatic complexity (control statements)', pre: true, post: true },
    { key: 'CCYCL2', label: 'Extended cyclomatic complexity (includes branching operators)', pre: true, post: true },
    { key: 'CCYCL3', label: 'Maximum cyclomatic complexity (includes branching operators and all switch branches)', pre: true, post: true },
    { key: 'CSTRUC', label: 'Structure complexity (Henry and Kafura)', pre: true, post: true },
    { key: 'CHAL', label: 'Halstead volume', pre: true, post: true },
    { key: 'IFLOW', label: 'Information flow metric (Henry and Selig)', pre: true, post: true },
];

function showFunMetricsAggregatePanel(metrics: any[]): void {
    const panel = vscode.window.createWebviewPanel(
        'cscoutFunMetricsAggregate',
        'Function Metrics Table',
        vscode.ViewColumn.One,
        { enableScripts: false }
    );

    const aggregate = (rows: any[], key: string): { total: number; min: number; max: number } | null => {
        let total = 0, min = Infinity, max = -Infinity, any = false;
        for (const r of rows) {
            const v = r[key];
            if (v === null || v === undefined) continue;
            const n = Number(v);
            total += n;
            if (n < min) min = n;
            if (n > max) max = n;
            any = true;
        }
        return any ? { total, min, max } : null;
    };

    const naCells = '<td style="text-align:right">-</td>'.repeat(4);
    const numCells = (agg: { total: number; min: number; max: number } | null, count: number): string => {
        if (!agg) return naCells;
        const avg = count > 0 ? (agg.total / count).toFixed(2) : '-';
        return `<td style="text-align:right">${agg.total}</td><td style="text-align:right">${agg.min}</td>`
            + `<td style="text-align:right">${agg.max}</td><td style="text-align:right">${avg}</td>`;
    };


    const preRows = metrics.filter(m => m.PRECPP === 1);
    const postRows = metrics.filter(m => m.PRECPP === 0);
    const count = new Set(metrics.map(m => m.FUNCTIONID)).size;

    const bodyRows = FUN_METRIC_TABLE.map(spec => {
        const preAgg = spec.pre ? aggregate(preRows, spec.key) : null;
        const postAgg = spec.post ? aggregate(postRows, spec.key) : null;
        return `<tr><td>${escapeHtml(spec.label)}</td>${numCells(preAgg, count)}${numCells(postAgg, count)}</tr>`;
    }).join('');

    const nonce = getNonce();
    panel.webview.html = `<!doctype html><html><head>
${getWebviewCsp(panel.webview, nonce)}
<style>
        body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:1em}
        table{border-collapse:collapse;width:100%}
        th,td{padding:4px 8px;border:1px solid var(--vscode-panel-border);white-space:nowrap;text-align:right}
        th{background:var(--vscode-editor-background);position:sticky;top:0;border-bottom:2px solid var(--vscode-panel-border)}
        td:first-child,th:first-child{text-align:left}
    </style></head><body>
    <h1>Function Metrics</h1>
    <p>Number of elements: ${count}</p>
    <div style="overflow:auto;max-height:80vh">
    <table>
        <thead>
            <tr><th></th><th colspan="4" style="text-align:center">Pre-cpp</th><th colspan="4" style="text-align:center">Post-cpp</th></tr>
            <tr><th style="text-align:left">Metric</th><th>Total</th><th>Min</th><th>Max</th><th>Avg</th><th>Total</th><th>Min</th><th>Max</th><th>Avg</th></tr>
        </thead>
        <tbody>${bodyRows}</tbody>
    </table>
    </div>
    </body></html>`;
}

function showWalkthrough(): void {
    const panel = vscode.window.createWebviewPanel(
        'cscoutWalkthrough',
        'CScout - Getting Started',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel.webview.html = getWalkthroughHtml(panel.webview);
    const listener = panel.webview.onDidReceiveMessage((msg) => {
        if (msg.command === 'openSettings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'cscout');
        }
    });
    panel.onDidDispose(() => listener.dispose());
}

function getWalkthroughHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!doctype html>
<html><head><meta charset="utf-8">
${getWebviewCsp(webview, nonce)}
<style>
body { font-family: var(--vscode-font-family); padding: 2em; max-width: 800px; line-height: 1.6; }
h1 { color: var(--vscode-textLink-foreground); border-bottom: 2px solid var(--vscode-panel-border); padding-bottom: .5em; }
h2 { margin-top: 2em; color: var(--vscode-textLink-foreground); }
.step { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 1em 1.5em; margin: 1em 0; border-left: 3px solid var(--vscode-textLink-foreground); }
.step-number { font-size: .8em; font-weight: bold; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .1em; }
code { background: var(--vscode-textCodeBlock-background); padding: .1em .4em; border-radius: 3px; font-family: var(--vscode-editor-font-family); }
pre { background: var(--vscode-textCodeBlock-background); padding: 1em; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: .5em 1.2em; border-radius: 4px; cursor: pointer; font-size: .95em; margin-top: .5em; }
button:hover { background: var(--vscode-button-hoverBackground); }
.check { color: #4caf50; font-weight: bold; }
.warn { color: var(--vscode-inputValidation-warningForeground); }
table { border-collapse: collapse; width: 100%; margin: .5em 0; }
td, th { padding: .4em .8em; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
th { color: var(--vscode-descriptionForeground); font-size: .9em; }
</style>
</head><body>

<h1>🔍 CScout - Getting Started</h1>
<p>CScout is a whole-program C source code analyzer that understands the C preprocessor. This extension brings CScout's analysis directly into VS Code.</p>

<div class="step">
<div class="step-number">Step 1 - Prerequisites</div>
<h2>Install Required Tools</h2>
<p>The extension needs the following tools installed on your system (Linux/macOS) or accessible via WSL (Windows):</p>
<table>
<tr><th>Tool</th><th>Purpose</th><th>Install</th></tr>
<tr><td><code>cscout</code></td><td>C analysis engine</td><td><a href="https://github.com/dspinellis/cscout">Build from source</a></td></tr>
<tr><td><code>python3</code></td><td>Runs csapi.py REST server</td><td>System package manager</td></tr>
<tr><td><code>sqlite3</code></td><td>Stores analysis database</td><td>System package manager</td></tr>
<tr><td><code>dot</code> <span style="color:var(--vscode-descriptionForeground);">(Optional)</span></td><td>Generates Call & Include graphs</td><td>System package manager (<code>graphviz</code>)</td></tr>
</table>
<p>On Ubuntu/Debian: <code>sudo apt install python3 sqlite3 graphviz</code></p>
<p>On macOS (with Homebrew): <code>brew install python3 sqlite graphviz</code></p>
<p>On Windows with WSL: open a WSL terminal and run the Ubuntu/Debian command above.</p>
<p>On Windows with Cygwin: use the Cygwin package manager (<code>setup-x86_64.exe</code>) to install <code>python3</code>, <code>sqlite3</code>, and <code>graphviz</code>.</p>
<p>Once installed, run <strong>CScout: Verify Setup</strong> from the Control Panel to confirm all tool paths are configured correctly.</p>
</div>

<div class="step">
<div class="step-number">Step 2 - Configure Paths</div>
<h2>Set Up Extension Settings</h2>
<p>Tell the extension where to find the CScout tools:</p>
<pre><code># In VS Code settings (cscout.*):
cscout.binaryPath     - path to the CScout binary
cscout.cscocoPyPath   - path to cscoco.py (for CMake/Meson projects)
cscout.csapiPyPath    - path to csapi.py (REST server)
cscout.csmakePath     - path to csmake (for Makefile projects)</code></pre>
<button onclick="openSettings()">Open CScout Settings</button>
</div>

<div class="step">
<div class="step-number">Step 3 - Open a C Project</div>
<h2>Supported Build Systems</h2>
<p>Open any C project folder in VS Code. The extension supports:</p>
<table>
<tr><th>Build System</th><th>What the extension runs automatically</th></tr>
<tr><td>Existing <code>.cs</code> file</td><td>Used directly - fastest option</td></tr>
<tr><td>CMake</td><td>Runs <code>cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON</code> then cscoco</td></tr>
<tr><td>Meson</td><td>Runs <code>meson setup build</code> then cscoco</td></tr>
<tr><td>Makefile</td><td>Intercepts build with csmake</td></tr>
<tr><td>Autotools</td><td>Runs <code>./configure</code> then csmake</td></tr>
</table>
</div>

<div class="step">
<div class="step-number">Step 4 - Start Analysis</div>
<h2>Run CScout</h2>
<p>Click the <strong>▶ Start CScout</strong> button in the sidebar, or run:</p>
<pre><code>Ctrl+Shift+P → CScout: Start Analysis</code></pre>
<p>The extension will:</p>
<ul>
<li>Detect your build system and ask which to use</li>
<li>Generate a CScout workspace file (<code>.cs</code>)</li>
<li>Run CScout analysis and build a SQLite database</li>
<li>Start the csapi REST server</li>
<li>Populate all sidebar panels</li>
</ul>
<p>Status bar shows: <code>⟳ CScout: Analyzing...</code> → <code>✓ CScout · N files</code></p>
</div>

<div class="step">
<div class="step-number">Step 5 - Explore Results</div>
<h2>What You Can Do</h2>
<table>
<tr><th>Feature</th><th>How to use</th></tr>
<tr><td>Browse identifiers</td><td>Expand groups in the Identifiers panel</td></tr>
<tr><td>Hover for info</td><td>Hover over any identifier in a C file</td></tr>
<tr><td>Go to definition</td><td>Ctrl+Click on any identifier</td></tr>
<tr><td>Find all references</td><td>Shift+F12 on any identifier</td></tr>
<tr><td>Rename identifier</td><td>F2 on any identifier (whole-program rename)</td></tr>
<tr><td>Inspect identifier</td><td>Click Inspect in the hover tooltip</td></tr>
<tr><td>Call graph</td><td>Click Call Graph in the hover tooltip</td></tr>
<tr><td>Unused warnings</td><td>Check the Problems panel</td></tr>
</table>
</div>

<hr>
<p style="color: var(--vscode-descriptionForeground); font-size: .9em;">
CScout is developed by <a href="https://github.com/dspinellis">Diomidis Spinellis</a>.
The VS Code extension is part of GSoC 2026.
</p>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function openSettings() {
    vscode.postMessage({ command: 'openSettings' });
}
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}

export function deactivate(): void {
    /* handled via context subscriptions */
}