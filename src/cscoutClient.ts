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


import * as http from 'http';

/*
 * Field naming: csapi returns SQL column names verbatim (EID, NAME,
 * FUN, UNUSED, etc.).  We do not translate - what you see in the API
 * matches what the extension code accesses.
 *
 * TODO: none of the fields on the interfaces below are documented. A lot of
 * them are CScout's own internal analysis flags (CPPCONST, DEFCCONSTVAL,
 * NOTDEFCCONSTVAL, EXPCCONSTVAL, NOTEXPCCONSTVAL, SUETAG, SUMEMBER, YACC,
 * and others) and need a real explanation of what each one represents, not
 * just its column name. Needs to be documented properly.
 */

export interface CScoutIdentifier {
	EID: number;
	NAME: string;
	READONLY: number;
	UNDEFMACRO: number;
	UNDEFEDMACRO?: number;
	REDEFEDSAMEMACRO?: number;
	REDEFEDDIFFMACRO?: number;
	MACRO: number;
	MACROARG: number;
	CPPCONST: number;
	CPPSTRVAL: number;
	DEFCCONSTVAL: number;
	NOTDEFCCONSTVAL: number;
	EXPCCONSTVAL: number;
	NOTEXPCCONSTVAL: number;
	ORDINARY: number;
	SUETAG: number;
	SUMEMBER: number;
	LABEL: number;
	TYPEDEF: number;
	ENUM: number;
	YACC: number;
	FUN: number;
	CSCOPE: number;
	LSCOPE: number;
	UNUSED: number;
}

export interface CScoutFile {
	FID: number;
	NAME: string;
	RO: number;
}

export interface CScoutFileDetail {
	file: CScoutFile;
	metrics: Record<string, number>;
	functions: { ID: number; NAME: string; FANIN: number; FANOUT: number | null; CCYCL1: number | null; LNUM: number | null }[];
	includes: CScoutFile[];
	included_by: CScoutFile[];
}

export interface CScoutAttribute {
	id: string;
	name: string;
}

export interface CScoutFunction {
	ID: number;
	NAME: string;
	ISMACRO: number;
	DEFINED: number;
	DECLARED: number;
	FILESCOPED: number;
	FID: number;
	FILE: string | null;
	FOFFSET: number;
	LNUM: number | null;
	FANIN: number;
	FANOUT: number | null;
	CCYCL1: number | null;
	CCYCL1_PRE?: number | null;
}

export interface CScoutLocation {
	FID: number;
	FILE: string;
	FOFFSET: number;
	LNUM: number | null;
	// TODO: check if dead code.
	LINE_START_OFFSET?: number;
	RO: number;
}

export interface CScoutCallEntry {
	ID: number;
	NAME: string;
	FID: number;
	FOFFSET: number;
	FILE: string;
}

export interface CScoutFileMetric {
	FID: number;
	PRECPP: number;
	[key: string]: number | null;
}

export interface CScoutFuncMetric {
	FUNCTIONID: number;
	PRECPP: number;
	[key: string]: number | null;
}

export interface CScoutIdentifierClassStat {
	class: string;
	pre_cpp_total: number;
	distinct: number;
	avg_len: number | null;
	min_len: number | null;
	max_len: number | null;
}

/*
 * Every identifier token in one file (GET /file/tokens). tokens is a flat
 * [byteOffset, index, byteOffset, index, ...] list in offset order; index
 * points into eids and names.
 */
export interface CScoutFileTokens {
	fid: number;
	eids: number[];
	names: string[];
	tokens: number[];
}

// A function whose whole name is the hovered identifier (not a partial
// match from token pasting).
export interface CScoutHoverFunction {
	ID: number;
	NAME: string;
	ISMACRO: number;
	DEFINED: number;
	FILESCOPED: number;
	FANIN: number | null;
	FANOUT: number | null;
	CCYCL1: number | null;
	CCYCL1_PRE: number | null;
	DEF_FID: number | null;
	DEF_FOFFSET: number | null;
	DEF_FILE: string | null;
	DEF_LNUM: number | null;
}

export interface CScoutHoverData {
	identifier: CScoutIdentifier;
	file_count: number;
	// CScout's should_be_static rule, evaluated server-side for this one
	// identifier - the same rule used by the sidebar and diagnostics, not
	// a separate copy of it.
	should_be_static: boolean;
	functions: CScoutHoverFunction[];
}

export interface CScoutLineCandidate {
	EID: number;
	NAME: string;
	FOFFSET: number;
	COLUMN: number;
}

export interface CScoutRefactorPreview {
	eid: number;
	old_name: string;
	new_name: string;
	total_replacements: number;
	locations: CScoutLocation[];
}

export interface CScoutStatus {
	status: string;
	indexes_ready: boolean;
}

export interface CScoutProject {
	PID: number;
	NAME: string;
}

export interface CScoutIdentifierDetail {
	identifier: CScoutIdentifier;
	locations: CScoutLocation[];
	occurrences: number;
	projects: CScoutProject[];
	dependent_files: { FID: number; NAME: string; RO: number }[];
	associated_functions: { ID: number; NAME: string; FILE: string; FOFFSET: number }[];
	function_detail: {
		function: CScoutFunction;
		callers_count: number;
		callees_count: number;
		definition: { FUNCTIONID: number; FIDBEGIN: number; FOFFSETBEGIN: number; FIDEND: number; FOFFSETEND: number; FILE: string } | null;
		metrics: CScoutFuncMetric[];
	} | null;
}

export interface CScoutRefactorApplyResult {
	old_name: string;
	new_name: string;
	modified_files: string[];
	total_replacements: number;
}

export interface IdentifierFilters {
	query?: string;
	name?: string;
	name_ne?: string;
	limit?: number;
	offset?: number;
}

export interface FunctionFilters {
	query?: string;
	name?: string;
	limit?: number;
	offset?: number;
}

export class CScoutClient {

	constructor(private host: string, private port: number) { }

	getBaseUrl(): string {
		return `http://${this.host}:${this.port}`;
	}

	/*
	 * Basic GET returning parsed JSON.  Rejects on network error,
	 * non-2xx status, or unparseable body.
	 */
	private get<T>(path: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const req = http.get(
				{
					host: this.host,
					port: this.port,
					path,
					timeout: 30_000,
				},
				(res) => {
					let body = '';
					res.setEncoding('utf-8');
					res.on('data', (chunk) => (body += chunk));
					res.on('end', () => {
						if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
							reject(new Error(`csapi ${path}: HTTP ${res.statusCode}`));
							return;
						}
						try {
							resolve(JSON.parse(body) as T);
						} catch {
							reject(new Error(`csapi ${path}: invalid JSON response`));
						}
					});
				}
			);
			req.on('timeout', () => {
				req.destroy();
				reject(new Error(`csapi ${path}: timeout`));
			});
			req.on('error', reject);
		});
	}

	// Same as get<T> above, but skips JSON.parse. Used for endpoints that return
	// SVG or HTML directly (call graph, include graph, rename preview), where
	// JSON.parse would just fail on the response body.
	public getRaw(path: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const req = http.get(
				{
					host: this.host,
					port: this.port,
					path,
					timeout: 30_000,
				},
				(res) => {
					let body = '';
					res.setEncoding('utf-8');
					res.on('data', (chunk) => (body += chunk));
					res.on('end', () => {
						if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
							reject(new Error(`csapi ${path}: HTTP ${res.statusCode}`));
							return;
						}
						resolve(body);
					});
				}
			);
			req.on('timeout', () => {
				req.destroy();
				reject(new Error(`csapi ${path}: timeout`));
			});
			req.on('error', reject);
		});
	}

	private buildQuery(params: Record<string, unknown>): string {
		const parts: string[] = [];
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === null) {
				continue;
			}
			parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		}
		return parts.length ? `?${parts.join('&')}` : '';
	}

	async getStatus(): Promise<CScoutStatus> {
		return this.get<CScoutStatus>('/status');
	}

	// TODO: check if dead code.
	async isAlive(): Promise<boolean> {
		try {
			const status = await this.getStatus();
			return status.status === 'ok';
		} catch {
			return false;
		}
	}

	async getIdentifiers(filters: IdentifierFilters = {}): Promise<CScoutIdentifier[]> {
		return this.get<CScoutIdentifier[]>('/identifiers' + this.buildQuery(filters as Record<string, unknown>));
	}

	async getFileTokens(fid: number): Promise<CScoutFileTokens> {
		return this.get<CScoutFileTokens>(`/file/tokens?fid=${fid}`);
	}

	async getIdentifierHover(eid: number): Promise<CScoutHoverData> {
		return this.get<CScoutHoverData>(`/identifier/hover?eid=${eid}`);
	}

	async getIdentifierCandidates(fid: number, line: number, name: string): Promise<CScoutLineCandidate[]> {
		return this.get<CScoutLineCandidate[]>('/identifier/candidates' + this.buildQuery({ fid, line, name }));
	}

	/** Identifiers named exactly name (not a substring match), at most limit of them. */
	async getIdentifiersExact(name: string, limit: number): Promise<CScoutIdentifier[]> {
		return this.get<CScoutIdentifier[]>('/identifiers/exact' + this.buildQuery({ name, limit }));
	}

	/**
	 * Fetch per-category identifier counts with a single SQL query.
	 * Used by the sidebar to show folder counts without loading all rows.
	 */
	async getIdentifierCounts(): Promise<Record<string, number>> {
		return this.get<Record<string, number>>('/identifiers/counts');
	}

	async getIdentifierStats(): Promise<{ writable: CScoutIdentifierClassStat[]; readonly: CScoutIdentifierClassStat[] }> {
		return this.get<{ writable: CScoutIdentifierClassStat[]; readonly: CScoutIdentifierClassStat[] }>('/identifiers/stats');
	}

	async getIdentifier(eid: number, limit?: number): Promise<CScoutIdentifierDetail> {
		const q = limit ? `&limit=${limit}` : '';
		return this.get<CScoutIdentifierDetail>(`/identifier?eid=${eid}${q}`);
	}

	async getFiles(query?: string): Promise<CScoutFile[]> {
		const q = query ? `?query=${query}` : '';
		return this.get<CScoutFile[]>(`/files${q}`);
	}

	// TODO: check if dead code.
	async getFilemetrics(fid: number): Promise<CScoutFileMetric[]> {
		return this.get<CScoutFileMetric[]>(`/filemetrics?fid=${fid}`);
	}

	async getFunctions(filters: FunctionFilters = {}): Promise<CScoutFunction[]> {
		return this.get<CScoutFunction[]>('/functions' + this.buildQuery(filters as Record<string, unknown>));
	}

	/**
	 * Fetch per-category function counts with a single SQL query.
	 * Used by the sidebar to show folder counts without loading all rows.
	 */
	async getFunctionCounts(): Promise<Record<string, number>> {
		return this.get<Record<string, number>>('/functions/counts');
	}

	/**
	 * Fetch a single function by exact name (defined functions only).
	 * Name alone does not identify a function: static functions with the
	 * same name in different files all match, and the server returns
	 * whichever comes first. Use getIdentifierHover() to find the
	 * function for a known identifier.
	 */
	async getFunctionByName(name: string): Promise<CScoutFunction | null> {
		return this.get<CScoutFunction | null>(`/functions/byname?name=${encodeURIComponent(name)}`);
	}

	/**
	 * Fetch per-category file counts.
	 * Used by the sidebar to show folder counts without loading all rows.
	 */
	async getFileCounts(): Promise<Record<string, number>> {
		return this.get<Record<string, number>>('/files/counts');
	}

	async getFunmetrics(fnid: number): Promise<CScoutFuncMetric[]> {
		return this.get<CScoutFuncMetric[]>(`/funmetrics?fnid=${fnid}`);
	}

	// TODO: check if dead code.
	async getCallers(eid: number): Promise<CScoutCallEntry[]> {
		return this.get<CScoutCallEntry[]>(`/callers?fnid=${eid}`);
	}

	// TODO: check if dead code.
	async getCallees(eid: number): Promise<CScoutCallEntry[]> {
		return this.get<CScoutCallEntry[]>(`/callees?fnid=${eid}`);
	}

	// TODO: check if dead code.
	async getProjects(): Promise<CScoutProject[]> {
		return this.get<CScoutProject[]>('/projects');
	}

	async previewRename(eid: number, newName: string): Promise<CScoutRefactorPreview> {
		return this.get<CScoutRefactorPreview>(
			`/rename/preview?eid=${eid}&newname=${encodeURIComponent(newName)}`
		);
	}

	/*
	 * Ask csapi to shut down gracefully.  Called before killing the
	 * process so listeners can clean up.  Errors are ignored - the
	 * server may already be gone.
	 */
	async quit(): Promise<void> {
		try {
			await this.get<unknown>('/quit');
		} catch {
			/* server is gone or was never running - expected */
		}
	}
	async getIdentifierDetail(eid: number): Promise<CScoutIdentifierDetail> {
		return this.get<CScoutIdentifierDetail>(`/identifier/detail?eid=${eid}`);
	}

	async getFilemetricsAggregate(): Promise<CScoutFileMetric[]> {
		return this.get<CScoutFileMetric[]>('/filemetrics/aggregate');
	}

	async getFunmetricsAggregate(): Promise<CScoutFuncMetric[]> {
		return this.get<CScoutFuncMetric[]>('/funmetrics/aggregate');
	}

	async getFileDetail(fid: number): Promise<CScoutFileDetail> {
		return this.get<CScoutFileDetail>(`/file/detail?fid=${fid}`);
	}

	async getIdentifierAttributes(): Promise<CScoutAttribute[]> {
		return this.get<CScoutAttribute[]>('/attributes/identifiers');
	}

	async getFileAttributes(): Promise<CScoutAttribute[]> {
		return this.get<CScoutAttribute[]>('/attributes/files');
	}

	// TODO: check if dead code.
	async getProjectFiles(pid: number): Promise<CScoutFile[]> {
		return this.get<CScoutFile[]>(`/project/files?pid=${pid}`);
	}

	// TODO: check if dead code.
	async applyRename(eid: number, newName: string): Promise<CScoutRefactorApplyResult> {
		return this.get<CScoutRefactorApplyResult>(
			`/rename/apply?eid=${eid}&newname=${encodeURIComponent(newName)}`
		);
	}
}
