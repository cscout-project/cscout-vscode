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


// A byte offset in a file maps to exactly one identifier (CScout's
// TOKENS table: PRIMARY KEY(FID, FOFFSET)). This tracks that mapping
// for one open document and keeps it correct across edits.

import type { CScoutFileTokens, CScoutHoverFunction } from './cscoutClient';

// none = nothing recorded here (keyword, comment); unknown = this text
// changed since analysis, so the map can't say.
export type TokenLookup =
	| { kind: 'exact'; eid: number; name: string; start: number; end: number }
	| { kind: 'none' }
	| { kind: 'unknown' };

export class TokenMap {
	private offsets: Int32Array;
	private index: Int32Array;
	private count: number;
	// An empty range [p, p) marks a deletion point.
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

	get modified(): boolean {
		return this.edited;
	}

	get size(): number {
		return this.count;
	}

	private lengthAt(i: number): number {
		return this.names[this.index[i]].length;
	}

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

	invalidateFrom(offset: number, documentLength: number): void {
		let i = this.lowerBound(offset);
		if (i > 0 && this.offsets[i - 1] + this.lengthAt(i - 1) > offset) {
			i--;
		}
		this.count = i;
		this.addDirty(offset, Math.max(offset, documentLength));
		this.edited = true;
	}

	applyChange(offset: number, removed: number, inserted: number): void {
		const end = offset + removed;
		const delta = inserted - removed;
		this.edited = true;

		let i = this.lowerBound(offset);
		if (i > 0 && this.offsets[i - 1] + this.lengthAt(i - 1) > offset) {
			i--;
		}
		let write = i;
		for (let read = i; read < this.count; read++) {
			const start = this.offsets[read];
			const overlaps = start < end && start + this.lengthAt(read) > offset;
			if (overlaps) {
				continue;
			}
			this.offsets[write] = start >= end ? start + delta : start;
			this.index[write] = this.index[read];
			write++;
		}
		this.count = write;

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

	// A written word can map to several tokens (macro token-pasting
	// splits one name into parts with separate EIDs); only a gapless
	// run counts as exact.
	lookup(wordStart: number, wordEnd: number, cursor: number): TokenLookup {
		if (this.touchesDirty(wordStart, wordEnd)) {
			return { kind: 'unknown' };
		}
		let i = this.lowerBound(wordStart);
		if (i > 0 && this.offsets[i - 1] + this.lengthAt(i - 1) > wordStart) {
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

export function buildTokenMap(
	data: CScoutFileTokens,
	analyzed: Buffer | undefined,
	current: string
): TokenMap {
	const bytes = analyzed ?? Buffer.from(current, 'utf8');
	const text = analyzed ? bytes.toString('utf8') : current;
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

// CScout can record the same function once per project; those count as
// one definition. "ambiguous" means unrelated same-named functions in
// separate programs.
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
