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


/*
 * Pure logic for mapping an editor position to exactly one CScout
 * identifier (EID). Nothing here talks to VS Code or the server, so it
 * can be unit tested directly; identifierResolver.ts wires it up.
 *
 * CScout's TOKENS table has PRIMARY KEY(FID, FOFFSET): a byte offset in
 * a file belongs to at most one identifier. A TokenMap holds that table
 * for one open document, converted to the document's own (UTF-16)
 * offsets, and keeps it in step with edits so a position can still be
 * looked up exactly after the file changes.
 */

import type { CScoutFileTokens, CScoutHoverFunction } from './cscoutClient';

/*
 * What a TokenMap knows about a word in the document:
 *  exact   - the word is exactly the analyzed token(s), unchanged since
 *            analysis; eid/name/start/end describe the token under the
 *            cursor (a word can be several tokens, see lookup()).
 *  none    - the text is unchanged since analysis and CScout recorded no
 *            identifier here (a keyword, a comment, an #if 0 block).
 *  unknown - this text changed since analysis, so the map can't say.
 */
export type TokenLookup =
	| { kind: 'exact'; eid: number; name: string; start: number; end: number }
	| { kind: 'none' }
	| { kind: 'unknown' };

export class TokenMap {
	// Document offset of each token, ascending, and an index into
	// eids/names for it. Tokens never overlap.
	private offsets: Int32Array;
	private index: Int32Array;
	private count: number;
	// Text changed since analysis, as [start, end) pairs in ascending
	// order. An empty range [p, p) marks a deletion point.
	private dirty: number[] = [];
	private edited = false;

	constructor(
		readonly fid: number,
		offsets: Int32Array,
		index: Int32Array,
		readonly eids: number[],
		readonly names: string[]
	) {
		this.offsets = offsets;
		this.index = index;
		this.count = offsets.length;
	}

	/* True once the document differs from the analyzed text. */
	get modified(): boolean {
		return this.edited;
	}

	get size(): number {
		return this.count;
	}

	private lengthAt(i: number): number {
		return this.names[this.index[i]].length;
	}

	// First token whose offset is >= offset.
	private lowerBound(offset: number): number {
		let lo = 0;
		let hi = this.count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.offsets[mid] < offset) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/*
	 * Mark everything from offset to the end of the document as changed
	 * and drop the tokens there. Used when the analyzed text stops
	 * matching partway through a file.
	 */
	invalidateFrom(offset: number, documentLength: number): void {
		let i = this.lowerBound(offset);
		if (i > 0 && this.offsets[i - 1] + this.lengthAt(i - 1) > offset) {
			i--;
		}
		this.count = i;
		this.addDirty(offset, Math.max(offset, documentLength));
		this.edited = true;
	}

	/*
	 * Apply one edit: removed characters at offset were replaced by
	 * inserted characters. Tokens the edit touches the inside of are
	 * dropped, tokens after it move by the size difference, and the new
	 * text is recorded as changed. This mirrors VS Code's own
	 * contentChanges, so every offset stays exact, not estimated.
	 */
	applyChange(offset: number, removed: number, inserted: number): void {
		const end = offset + removed;
		const delta = inserted - removed;
		this.edited = true;

		let i = this.lowerBound(offset);
		// The one token that can start before the edit and run into it.
		if (i > 0 && this.offsets[i - 1] + this.lengthAt(i - 1) > offset) {
			i--;
		}
		let write = i;
		for (let read = i; read < this.count; read++) {
			const start = this.offsets[read];
			const overlaps = start < end && start + this.lengthAt(read) > offset;
			if (overlaps) {
				// Dropped: the edit is inside this token.
				continue;
			}
			this.offsets[write] = start >= end ? start + delta : start;
			this.index[write] = this.index[read];
			write++;
		}
		this.count = write;

		// Move changed ranges after the edit; fold touching ones into it.
		let newStart = offset;
		let newEnd = offset + inserted;
		const kept: number[] = [];
		for (let k = 0; k < this.dirty.length; k += 2) {
			const s = this.dirty[k];
			const e = this.dirty[k + 1];
			if (e < offset) {
				kept.push(s, e);
			} else if (s > end) {
				kept.push(s + delta, e + delta);
			} else {
				newStart = Math.min(newStart, s);
				newEnd = Math.max(newEnd, e > end ? e + delta : newEnd);
			}
		}
		this.dirty = kept;
		this.addDirty(newStart, newEnd);
	}

	private addDirty(start: number, end: number): void {
		let k = 0;
		while (k < this.dirty.length && this.dirty[k] < start) {
			k += 2;
		}
		this.dirty.splice(k, 0, start, end);
	}

	private touchesDirty(wordStart: number, wordEnd: number): boolean {
		for (let k = 0; k < this.dirty.length; k += 2) {
			const s = this.dirty[k];
			const e = this.dirty[k + 1];
			if (s === e ? (wordStart <= s && s <= wordEnd) : (s < wordEnd && e > wordStart)) {
				return true;
			}
		}
		return false;
	}

	/*
	 * Look up the word [wordStart, wordEnd) with the cursor at cursor.
	 *
	 * CScout sometimes splits one written identifier into several
	 * tokens: when a name like row_numberStepFunc is also produced by
	 * token pasting (name ## StepFunc) elsewhere, the written word is
	 * recorded as row_number + StepFunc, each with its own EID. So a
	 * word only counts as exact if its tokens cover it end to end with
	 * no gaps; the result is the token the cursor is on.
	 */
	lookup(wordStart: number, wordEnd: number, cursor: number): TokenLookup {
		if (this.touchesDirty(wordStart, wordEnd)) {
			return { kind: 'unknown' };
		}
		let i = this.lowerBound(wordStart);
		if (i > 0 && this.offsets[i - 1] + this.lengthAt(i - 1) > wordStart) {
			// A token straddles the start of the word: the word
			// boundaries don't match the analysis.
			return { kind: 'unknown' };
		}
		if (i >= this.count || this.offsets[i] >= wordEnd) {
			return { kind: 'none' };
		}
		let pos = wordStart;
		let hit = -1;
		for (; i < this.count && this.offsets[i] < wordEnd; i++) {
			if (this.offsets[i] !== pos) {
				return { kind: 'unknown' };
			}
			const next = pos + this.lengthAt(i);
			if (cursor >= pos && (cursor < next || (cursor === wordEnd && next === wordEnd))) {
				hit = i;
			}
			pos = next;
		}
		if (pos !== wordEnd || hit < 0) {
			return { kind: 'unknown' };
		}
		const k = this.index[hit];
		return {
			kind: 'exact',
			eid: this.eids[k],
			name: this.names[k],
			start: this.offsets[hit],
			end: this.offsets[hit] + this.names[k].length,
		};
	}

	/* Current [start, end) ranges of every token of identifier eid. */
	rangesOf(eid: number): [number, number][] {
		const k = this.eids.indexOf(eid);
		const ranges: [number, number][] = [];
		if (k < 0) {
			return ranges;
		}
		for (let i = 0; i < this.count; i++) {
			if (this.index[i] === k) {
				ranges.push([this.offsets[i], this.offsets[i] + this.names[k].length]);
			}
		}
		return ranges;
	}
}

/*
 * Build a TokenMap for a document.
 *
 * analyzed: the file's bytes as CScout saw them (read from disk), or
 *           undefined if the file can't be read.
 * current:  the document's text now, which may include unsaved edits.
 *
 * Every token is checked against the analyzed bytes (its name must be
 * at its offset). On an unchanged file this always holds; the first
 * token that fails means the file on disk changed after analysis, so
 * that token and everything after it are treated as unknown. The
 * remaining difference between the file on disk and the editor text is
 * then applied as one edit, so the map matches the editor exactly.
 */
export function buildTokenMap(
	data: CScoutFileTokens,
	analyzed: Buffer | undefined,
	current: string
): TokenMap {
	const bytes = analyzed ?? Buffer.from(current, 'utf8');
	const text = analyzed ? bytes.toString('utf8') : current;
	// Every character is one byte, so byte offsets are text offsets.
	const oneToOne = text.length === bytes.length;

	const nameBytes = data.names.map((n) => Buffer.from(n, 'utf8'));
	const total = data.tokens.length >> 1;
	const offsets = new Int32Array(total);
	const index = new Int32Array(total);

	let bytePos = 0;
	let textPos = 0;
	let good = 0;
	let failedAt = -1;
	for (; good < total; good++) {
		const off = data.tokens[2 * good];
		const k = data.tokens[2 * good + 1];
		const nb = nameBytes[k];
		if (
			off < bytePos ||
			off + nb.length > bytes.length ||
			bytes.compare(nb, 0, nb.length, off, off + nb.length) !== 0
		) {
			failedAt = off;
			break;
		}
		const at = textPos + (oneToOne ? off - bytePos : bytes.toString('utf8', bytePos, off).length);
		if (text.startsWith(data.names[k], at) === false) {
			failedAt = off;
			break;
		}
		offsets[good] = at;
		index[good] = k;
		bytePos = off;
		textPos = at;
	}

	const map = new TokenMap(data.fid, offsets.subarray(0, good), index.subarray(0, good), data.eids, data.names);
	if (failedAt >= 0) {
		const at = failedAt >= bytePos
			? textPos + (oneToOne ? failedAt - bytePos : bytes.toString('utf8', bytePos, Math.min(failedAt, bytes.length)).length)
			: textPos;
		map.invalidateFrom(at, text.length);
	}

	if (text !== current) {
		const [start, removed, inserted] = diffRange(text, current);
		map.applyChange(start, removed, inserted);
	}
	return map;
}

/*
 * The single edit that turns before into after: the common prefix and
 * suffix are kept, the middle is replaced. Returns [offset, removed,
 * inserted] in the same form as applyChange.
 */
export function diffRange(before: string, after: string): [number, number, number] {
	const max = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < max - prefix &&
		before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
	) {
		suffix++;
	}
	return [prefix, before.length - prefix - suffix, after.length - prefix - suffix];
}

/*
 * When the text changed, the server can still list the tokens with this
 * name on the same line (as analyzed). One distinct identifier there is
 * the answer; several can only be told apart by their byte column, and
 * if none sits at the cursor's column there is no answer.
 */
export function chooseLineCandidate(
	candidates: { EID: number; COLUMN: number }[],
	byteColumn: number
): { eid: number; byColumn: boolean } | undefined {
	const distinct = new Set(candidates.map((c) => c.EID));
	if (distinct.size === 1) {
		return { eid: candidates[0].EID, byColumn: false };
	}
	const atColumn = new Set(candidates.filter((c) => c.COLUMN === byteColumn).map((c) => c.EID));
	if (atColumn.size === 1) {
		return { eid: [...atColumn][0], byColumn: true };
	}
	return undefined;
}

/*
 * Which function a hovered identifier names.
 *  one       - a single definition. CScout can record the same function
 *              once per project; those rows share the definition and
 *              its metrics, and the one with the most callers is used.
 *  ambiguous - several different definitions (unrelated same-named
 *              functions in separate programs) and none, or more than
 *              one, in the current file.
 *  none      - no defined function has exactly this identifier as its
 *              name (declared only, or only part of a pasted name).
 */
export type FunctionPick =
	| { kind: 'one'; fn: CScoutHoverFunction }
	| { kind: 'ambiguous'; definitions: CScoutHoverFunction[] }
	| { kind: 'none' };

export function pickFunction(functions: CScoutHoverFunction[], currentFid: number | undefined): FunctionPick {
	const groups = new Map<string, CScoutHoverFunction>();
	for (const f of functions) {
		if (!f.DEFINED || f.DEF_FID == null || f.DEF_FOFFSET == null) {
			continue;
		}
		const key = `${f.DEF_FID}:${f.DEF_FOFFSET}`;
		const seen = groups.get(key);
		if (!seen || (f.FANIN ?? 0) > (seen.FANIN ?? 0)) {
			groups.set(key, f);
		}
	}
	const definitions = [...groups.values()];
	if (definitions.length === 0) {
		return { kind: 'none' };
	}
	if (definitions.length === 1) {
		return { kind: 'one', fn: definitions[0] };
	}
	const here = definitions.filter((f) => f.DEF_FID === currentFid);
	if (here.length === 1) {
		return { kind: 'one', fn: here[0] };
	}
	return { kind: 'ambiguous', definitions };
}
