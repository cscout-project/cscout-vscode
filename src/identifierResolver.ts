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


import * as fs from 'fs';
import * as vscode from 'vscode';
import { CScoutClient, CScoutHoverData } from './cscoutClient';
import { buildTokenMap, chooseLineCandidate, TokenMap } from './identity';
import { toEditorPath } from './platform';

// A C identifier. Every provider uses this one pattern so hover,
// navigation and rename all agree on what the word under the cursor is.
export const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/;

/*
 * Why a match could not come from the token map:
 *  edited       - this part of the file changed since the last analysis
 *  not-analyzed - the file was not part of the last analysis
 *  no-positions - the file's token positions could not be loaded
 */
export type FallbackReason = 'edited' | 'not-analyzed' | 'no-positions';

/*
 * How an editor position was matched to an identifier.
 *  exact     - through the file's token map: this is the identifier
 *              CScout recorded at this spot. modified means the document
 *              changed since analysis, so the identity is certain but
 *              facts about it (unused, callers, metrics) may be outdated.
 *  uncertain - matched on the analyzed line by name ('line'), by name
 *              and column ('line-column'), or because only one
 *              identifier has this name ('unique-name'). It may be a
 *              different identifier.
 *  unmatched - the text changed since analysis and nothing matched.
 */
export type Resolution =
	| { kind: 'exact'; eid: number; name: string; range: vscode.Range; fid: number; modified: boolean }
	| {
		kind: 'uncertain';
		eid: number;
		name: string;
		range: vscode.Range;
		fid: number | undefined;
		via: 'line' | 'line-column' | 'unique-name';
		why: FallbackReason;
	}
	| { kind: 'unmatched'; name: string; range: vscode.Range; why: FallbackReason };

// Open documents whose token maps are kept; the least recently used
// map beyond this is dropped and rebuilt if needed again.
const MAX_MAPS = 20;
const MAX_HOVER_DATA = 500;

// Never looked up by name: they are not identifiers.
const C_KEYWORDS = new Set([
	'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
	'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if',
	'inline', 'int', 'long', 'register', 'restrict', 'return', 'short',
	'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
	'unsigned', 'void', 'volatile', 'while', '_Alignas', '_Alignof',
	'_Atomic', '_Bool', '_Complex', '_Generic', '_Imaginary', '_Noreturn',
	'_Static_assert', '_Thread_local',
]);

function isC(document: vscode.TextDocument): boolean {
	return document.languageId === 'c' || document.languageId === 'cpp';
}

function pathKey(p: string): string {
	return process.platform === 'win32' ? p.toLowerCase() : p;
}

export class IdentifierResolver implements vscode.Disposable {
	private maps = new Map<string, TokenMap>();
	private building = new Map<string, Promise<TokenMap | undefined>>();
	private fileIds: Promise<Map<string, number>> | undefined;
	private hoverData = new Map<number, Promise<CScoutHoverData>>();
	private generation = 0;
	private warned = new Set<string>();
	private subscriptions: vscode.Disposable[];

	constructor(
		private getClient: () => CScoutClient | undefined,
		private channel: vscode.OutputChannel
	) {
		this.subscriptions = [
			vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
			vscode.workspace.onDidCloseTextDocument((d) => this.maps.delete(d.uri.toString())),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.prefetch(editor.document);
				}
			}),
		];
	}

	dispose(): void {
		for (const s of this.subscriptions) {
			s.dispose();
		}
		this.reset();
	}

	/* Forget everything. Called whenever the analysis starts, stops or finishes. */
	reset(): void {
		this.generation++;
		this.maps.clear();
		this.building.clear();
		this.fileIds = undefined;
		this.hoverData.clear();
		this.warned.clear();
	}

	/* Start building a document's token map without waiting for it. */
	prefetch(document: vscode.TextDocument): void {
		if (this.getClient() && isC(document)) {
			void this.mapFor(document).catch(() => undefined);
		}
	}

	/*
	 * Match the identifier at position to exactly one EID.
	 *
	 * 1. The file's token map: exact, and kept in step with every edit.
	 * 2. Only where the map can't answer (the text there changed since
	 *    analysis, or the file has no map): the analyzed line, by name,
	 *    and by column if the line has several identifiers of that name.
	 * 3. Then the only identifier in the project with this name.
	 * Nothing further: a name shared by several identifiers is never
	 * guessed.
	 */
	async resolve(
		document: vscode.TextDocument,
		position: vscode.Position,
		token?: vscode.CancellationToken
	): Promise<Resolution | undefined> {
		const client = this.getClient();
		if (!client) {
			return undefined;
		}
		const word = document.getWordRangeAtPosition(position, IDENTIFIER_PATTERN);
		if (!word) {
			return undefined;
		}
		const map = await this.mapFor(document).catch(() => undefined);
		if (token?.isCancellationRequested) {
			return undefined;
		}

		let why: FallbackReason = 'no-positions';
		if (map) {
			const found = map.lookup(document.offsetAt(word.start), document.offsetAt(word.end), document.offsetAt(position));
			if (found.kind === 'none') {
				return undefined;
			}
			if (found.kind === 'exact') {
				const range = new vscode.Range(document.positionAt(found.start), document.positionAt(found.end));
				// Always true while the map follows every edit. The check
				// is cheap and catches a map that fell out of step.
				if (document.getText(range) === found.name) {
					return { kind: 'exact', eid: found.eid, name: found.name, range, fid: map.fid, modified: map.modified };
				}
				this.channel.appendLine(`CScout: token positions for ${document.fileName} were out of step; rebuilding them.`);
				this.maps.delete(document.uri.toString());
			}
			why = 'edited';
		} else if (await this.fileIdOf(document) === undefined) {
			why = 'not-analyzed';
		}
		return this.resolveByName(client, document, position, word, map?.fid, why, token);
	}

	private async resolveByName(
		client: CScoutClient,
		document: vscode.TextDocument,
		position: vscode.Position,
		word: vscode.Range,
		knownFid: number | undefined,
		why: FallbackReason,
		token: vscode.CancellationToken | undefined
	): Promise<Resolution | undefined> {
		const name = document.getText(word);
		if (C_KEYWORDS.has(name) || isInsideCommentOrString(document, position)) {
			return undefined;
		}
		const fid = knownFid ?? await this.fileIdOf(document);
		try {
			if (fid !== undefined) {
				const candidates = await client.getIdentifierCandidates(fid, position.line + 1, name);
				if (token?.isCancellationRequested) {
					return undefined;
				}
				const column = Buffer.byteLength(document.lineAt(position.line).text.slice(0, word.start.character), 'utf8');
				const chosen = chooseLineCandidate(candidates, column);
				if (chosen) {
					return {
						kind: 'uncertain', eid: chosen.eid, name, range: word, fid,
						via: chosen.byColumn ? 'line-column' : 'line', why,
					};
				}
			}
			const named = await client.getIdentifiersExact(name, 2);
			if (token?.isCancellationRequested) {
				return undefined;
			}
			if (named.length === 1) {
				return { kind: 'uncertain', eid: named[0].EID, name, range: word, fid, via: 'unique-name', why };
			}
		} catch (err) {
			this.warnOnce('fallback', `CScout: name lookup failed (${(err as Error).message}). If this says HTTP 404, csapi.py is older than this extension.`);
		}
		if (why === 'not-analyzed') {
			return undefined;
		}
		return { kind: 'unmatched', name, range: word, why };
	}

	/* Hover data for one identifier, fetched by EID and cached by EID. */
	getHoverData(eid: number): Promise<CScoutHoverData> {
		const cached = this.hoverData.get(eid);
		if (cached) {
			this.hoverData.delete(eid);
			this.hoverData.set(eid, cached);
			return cached;
		}
		const client = this.getClient();
		if (!client) {
			return Promise.reject(new Error('CScout is not running'));
		}
		const pending = client.getIdentifierHover(eid);
		this.hoverData.set(eid, pending);
		pending.catch(() => {
			if (this.hoverData.get(eid) === pending) {
				this.hoverData.delete(eid);
			}
		});
		if (this.hoverData.size > MAX_HOVER_DATA) {
			this.hoverData.delete(this.hoverData.keys().next().value as number);
		}
		return pending;
	}

	/*
	 * Current ranges of every token of identifier eid in a document, taken
	 * from the document's token map, or undefined if it has none yet.
	 * Only returns an existing map; it never starts a build.
	 */
	mappedOccurrences(document: vscode.TextDocument, eid: number): vscode.Range[] | undefined {
		const map = this.maps.get(document.uri.toString());
		if (!map) {
			return undefined;
		}
		return map.rangesOf(eid).map(([s, e]) => new vscode.Range(document.positionAt(s), document.positionAt(e)));
	}

	private onChange(e: vscode.TextDocumentChangeEvent): void {
		if (e.contentChanges.length === 0) {
			return;
		}
		// A build still in flight reads the document text when it
		// finishes, so it already includes these changes.
		const map = this.maps.get(e.document.uri.toString());
		if (!map) {
			return;
		}
		// VS Code applies contentChanges one after the other in this
		// order, each offset relative to the text left by the previous.
		for (const c of e.contentChanges) {
			map.applyChange(c.rangeOffset, c.rangeLength, c.text.length);
		}
	}

	private mapFor(document: vscode.TextDocument): Promise<TokenMap | undefined> {
		const key = document.uri.toString();
		const map = this.maps.get(key);
		if (map) {
			this.maps.delete(key);
			this.maps.set(key, map);
			return Promise.resolve(map);
		}
		let pending = this.building.get(key);
		if (!pending) {
			const started = this.build(document, this.generation);
			pending = started.finally(() => {
				if (this.building.get(key) === pending) {
					this.building.delete(key);
				}
			});
			this.building.set(key, pending);
		}
		return pending;
	}

	private async build(document: vscode.TextDocument, generation: number): Promise<TokenMap | undefined> {
		const client = this.getClient();
		if (!client || !isC(document)) {
			return undefined;
		}
		const fid = await this.fileIdOf(document);
		if (fid === undefined) {
			return undefined;
		}
		let data;
		try {
			data = await client.getFileTokens(fid);
		} catch (err) {
			this.warnOnce('tokens', `CScout: could not load identifier positions (${(err as Error).message}); hover and navigation fall back to name matching. If this says HTTP 404, csapi.py is older than this extension.`);
			return undefined;
		}
		let analyzed: Buffer | undefined;
		if (document.uri.scheme === 'file') {
			analyzed = await fs.promises.readFile(document.uri.fsPath).catch(() => undefined);
		}
		if (generation !== this.generation || document.isClosed) {
			return undefined;
		}
		// From here on everything is synchronous, so no edit can land
		// between reading the text and registering the map.
		const map = buildTokenMap(data, analyzed, document.getText());
		if (analyzed && !document.isDirty && map.modified) {
			this.channel.appendLine(`CScout: ${document.fileName} changed after the last analysis; identifiers after the first change are matched by name until you re-analyze.`);
		}
		const key = document.uri.toString();
		this.maps.set(key, map);
		if (this.maps.size > MAX_MAPS) {
			this.maps.delete(this.maps.keys().next().value as string);
		}
		return map;
	}

	private async fileIdOf(document: vscode.TextDocument): Promise<number | undefined> {
		if (!this.fileIds) {
			const client = this.getClient();
			if (!client) {
				return undefined;
			}
			const generation = this.generation;
			const loading = client.getFiles().then((files) => {
				const ids = new Map<string, number>();
				for (const f of files) {
					ids.set(pathKey(toEditorPath(f.NAME)), f.FID);
				}
				return ids;
			});
			loading.catch(() => {
				if (this.generation === generation && this.fileIds === loading) {
					this.fileIds = undefined;
				}
			});
			this.fileIds = loading;
		}
		try {
			return (await this.fileIds).get(pathKey(document.uri.fsPath));
		} catch {
			return undefined;
		}
	}

	private warnOnce(key: string, message: string): void {
		if (!this.warned.has(key)) {
			this.warned.add(key);
			this.channel.appendLine(message);
		}
	}
}

/*
 * Whether position is inside a comment or a string literal. Scans the
 * file from the start, so it is only used on the fallback path; the
 * token map already knows that comments and strings hold no identifiers.
 */
export function isInsideCommentOrString(document: vscode.TextDocument, position: vscode.Position): boolean {
	const text = document.getText();
	const offset = document.offsetAt(position);

	let inString = false;
	let inChar = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < offset; i++) {
		const char = text[i];
		const nextChar = text[i + 1] || '';

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
			}
		} else if (inBlockComment) {
			if (char === '*' && nextChar === '/') {
				inBlockComment = false;
				i++;
			}
		} else if (inString) {
			if (char === '\\') {
				i++;
			} else if (char === '"') {
				inString = false;
			}
		} else if (inChar) {
			if (char === '\\') {
				i++;
			} else if (char === "'") {
				inChar = false;
			}
		} else if (char === '/' && nextChar === '/') {
			inLineComment = true;
			i++;
		} else if (char === '/' && nextChar === '*') {
			inBlockComment = true;
			i++;
		} else if (char === '"') {
			inString = true;
		} else if (char === "'") {
			inChar = true;
		}
	}

	return inLineComment || inBlockComment || inString || inChar;
}
