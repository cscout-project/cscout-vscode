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
import * as os from 'os';
import * as util from 'util';

const execFileAsync = util.promisify(cp.execFile);

// TODO: check if dead code.
export type Platform = 'linux' | 'darwin' | 'win32-wsl' | 'win32-native' | 'cygwin';

export interface ResolvedCommand {
	command: string;
	args: string[];
}

/*
 * Detect the runtime platform.  WSL detection matters because Windows
 * VS Code cannot execute Linux ELF binaries directly - everything must
 * be routed through 'wsl' when Linux binaries are in play.
 */
export function detectPlatform(): Platform {
	if (process.platform === 'linux') {
		// Running inside WSL counts as linux for our purposes because
		// binaries live natively and no wrapping is needed.
		return 'linux';
	}
	if (process.platform === 'darwin') {
		return 'darwin';
	}
	if (process.platform === 'win32') {
		// Cygwin sets specific env vars; check before assuming native win32.
		if (process.env.CYGWIN || process.env.TERM === 'cygwin') {
			return 'cygwin';
		}
		// This just returns the platform name here. Whether a command
		// actually gets routed through WSL happens later, in
		// resolveCommand(). WSL availability itself is checked lazily,
		// the first time isWslAvailable() is actually called, not here
		// and not at startup, then the result is cached after that.
		return 'win32-native';
	}
	return 'linux';
}

let wslMountRoot = '/mnt/';

// TODO: check if dead code.
export function setWslMountRootForTesting(root: string) {
	wslMountRoot = root;
}

// WSL normally mounts C: at /mnt/c, but a user can change that in their own
// /etc/wsl.conf. Run wslpath and parse its output to detect that override.
function detectWslMountRoot() {
	if (process.platform !== 'win32') {
		return;
	}
	try {
		const out = cp.execSync('wsl.exe wslpath "C:\\"', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
		const parsed = out.trim();
		const match = /^(.*\/)c\/$/.exec(parsed.toLowerCase());
		if (match) {
			wslMountRoot = match[1];
		}
	} catch {
		wslMountRoot = '/mnt/';
	}
}

/*
 * Best-effort check for WSL availability on Windows. Not called at
 * activation, called lazily the first time something actually needs to
 * know (resolveCommand or commandRunsInWsl). The result is cached after
 * that first call, so either way it only really runs once per session.
 * Kept synchronous since it only ever runs on Windows.
 */
let wslAvailable: boolean | undefined;
export function isWslAvailable(): boolean {
	if (wslAvailable !== undefined) {
		return wslAvailable;
	}
	if (process.platform !== 'win32') {
		wslAvailable = false;
		return false;
	}
	try {
		cp.execSync('wsl.exe --status', { stdio: 'ignore', timeout: 3000 });
		wslAvailable = true;
		detectWslMountRoot();
	} catch {
		wslAvailable = false;
	}
	return wslAvailable;
}

/*
 * Determine whether a given path looks like a Linux/WSL path that would
 * require routing through wsl.  We use this to decide per-command whether
 * to wrap: a user with all-native Windows tools does not want wsl added.
 */
// TODO: check if dead code.
function isLinuxPath(p: string): boolean {
	// Absolute POSIX paths and /mnt/ style WSL mounts.
	if (p.startsWith('/')) {
		return true;
	}
	// Windows drive letters are not Linux paths.
	if (/^[a-zA-Z]:[\\/]/.test(p)) {
		return false;
	}
	return false;
}

/*
 * Wrap a command for execution on the current platform.  If the caller
 * passes a bare command name (e.g. 'python3'), it is looked up in PATH
 * as normal.  If the caller passes an absolute Linux path on Windows,
 * we route through 'wsl -e'.
 */
export function resolveCommand(command: string, args: string[]): ResolvedCommand {
	const platform = detectPlatform();

	if (platform === 'win32-native' && isWslAvailable() && isLinuxPath(command)) {
		return {
			command: 'wsl.exe',
			args: ['-e', command, ...args],
		};
	}

	return { command, args };
}

/*
 * Translate a Windows path to a WSL path for passing as an argument to
 * a wsl-wrapped command.  C:\Users\foo becomes /mnt/c/Users/foo.
 * Only applied when we know we are running the command through wsl.
 */
export function toWslPath(winPath: string): string {
	if (!winPath) {
		return winPath;
	}
	const match = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath);
	if (!match) {
		return winPath;
	}
	const drive = match[1].toLowerCase();
	const rest = match[2].replace(/\\/g, '/');
	return `${wslMountRoot}${drive}/${rest}`;
}

/*
 * Translate a WSL path back to a Windows path for use in VS Code APIs
 * that expect native paths (e.g. showTextDocument).  /mnt/c/foo becomes
 * C:\foo.
 */
export function fromWslPath(wslPath: string): string {
	if (!wslPath) {
		return wslPath;
	}
	if (wslPath.startsWith(wslMountRoot)) {
		const withoutRoot = wslPath.substring(wslMountRoot.length);
		const match = /^([a-zA-Z])\/(.*)$/.exec(withoutRoot);
		if (match) {
			const drive = match[1].toUpperCase();
			const rest = match[2].replace(/\//g, '\\');
			return `${drive}:\\${rest}`;
		}
	}
	return wslPath;
}

/*
 * Translate a Windows path to a Cygwin path. C:\Users becomes /cygdrive/c/Users.
 */
export function toCygwinPath(winPath: string): string {
	if (!winPath) return winPath;
	const match = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath);
	if (!match) return winPath;
	const drive = match[1].toLowerCase();
	const rest = match[2].replace(/\\/g, '/');
	return `/cygdrive/${drive}/${rest}`;
}

/*
 * Translate a Cygwin path to a Windows path. /cygdrive/c/Users becomes C:\Users.
 */
export function fromCygwinPath(cygPath: string): string {
	if (!cygPath) return cygPath;
	const match = /^\/cygdrive\/([a-zA-Z])\/(.*)$/.exec(cygPath);
	if (match) {
		const drive = match[1].toUpperCase();
		const rest = match[2].replace(/\//g, '\\');
		return `${drive}:\\${rest}`;
	}
	return cygPath;
}

/*
 * Centralized translation for Editor -> CScout (backend).
 */
export function toCScoutPath(editorPath: string, platform: Platform = detectPlatform()): string {
	if (!editorPath) return editorPath;
	if (platform === 'linux' || platform === 'darwin') return editorPath;
	if (platform === 'cygwin') return toCygwinPath(editorPath);
	if (platform === 'win32-native') return editorPath.replace(/\\/g, '/');
	return toWslPath(editorPath);
}

/*
 * Centralized translation for CScout (backend) -> Editor.
 */
export function toEditorPath(cscoutPath: string, platform: Platform = detectPlatform()): string {
	if (!cscoutPath) return cscoutPath;
	if (platform === 'linux' || platform === 'darwin') return cscoutPath;
	if (platform === 'cygwin') return fromCygwinPath(cscoutPath);
	if (platform === 'win32-native') {
		if (cscoutPath.startsWith(wslMountRoot)) {
			return fromWslPath(cscoutPath);
		}
		return cscoutPath.replace(/\//g, '\\');
	}
	return fromWslPath(cscoutPath);
}

/*
 * Normalize a path for the current platform.  When passing paths to a
 * command that will run through wsl, we need WSL-format paths; when
 * passing to a native command, we need native format.
 */
export function pathForCommand(p: string, commandRunsInWsl: boolean): string {
	if (!p) {
		return p;
	}
	if (commandRunsInWsl && /^[a-zA-Z]:[\\/]/.test(p)) {
		return toWslPath(p);
	}
	if (!commandRunsInWsl && p.startsWith(wslMountRoot) && process.platform === 'win32') {
		return fromWslPath(p);
	}
	return p;
}

/*
 * Does a command, once resolved, ultimately run inside WSL?  Used by
 * callers to know whether path arguments need conversion.
 */
export function commandRunsInWsl(command: string): boolean {
	if (detectPlatform() !== 'win32-native') {
		return false;
	}
	if (!isWslAvailable()) {
		return false;
	}
	return isLinuxPath(command);
}

/*
 * Return a human-readable environment summary for the CScout output
 * channel.  Helps users understand what path resolution is happening.
 */
export function describeEnvironment(): string {
	const platform = detectPlatform();
	const wsl = platform === 'win32-native' ? isWslAvailable() : false;
	return `Platform: ${platform}${wsl ? ' (WSL available)' : ''} | Node ${process.version} | ${os.arch()}`;
}

/*
 * Resolve a python script path relative to the installed cscout binary,
 * unless it is already an absolute path. Prevents relative paths from
 * incorrectly resolving against the workspace root.
 */
export async function resolveScriptPath(scriptPath: string, cscoutBinPath: string, commandRunsInWsl: boolean): Promise<string> {
	if (!scriptPath) return scriptPath;

	// 1. If the script path is absolute, return it as-is.
	if (scriptPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(scriptPath)) {
		return scriptPath;
	}

	// 2. We need to resolve relative to the cscout binary.
	let absoluteCscoutBin = cscoutBinPath;
	if (!absoluteCscoutBin.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(absoluteCscoutBin)) {
		// It's a bare command like 'cscout'. Find it dynamically.
		try {
			if (commandRunsInWsl) {
				const { stdout } = await execFileAsync('wsl.exe', ['-e', 'which', cscoutBinPath]);
				absoluteCscoutBin = stdout.trim();
			} else if (detectPlatform() === 'win32-native') {
				const { stdout } = await execFileAsync('where.exe', [cscoutBinPath]);
				absoluteCscoutBin = stdout.split('\r\n')[0].trim();
			} else {
				const { stdout } = await execFileAsync('which', [cscoutBinPath]);
				absoluteCscoutBin = stdout.trim();
			}
		} catch {
			return scriptPath;
		}
	}

	// 3. Resolve the script relative to the cscout binary's directory
	if (absoluteCscoutBin) {
		const separator = absoluteCscoutBin.includes('/') ? '/' : '\\';
		const dir = absoluteCscoutBin.substring(0, absoluteCscoutBin.lastIndexOf(separator));
		
		// Note: We currently assume Python scripts (cscoco.py, csapi.py) are installed 
		// as siblings to the main cscout binary (e.g., both in /usr/local/bin).
		// If a user runs 'make install' in the future and csapi.py is moved to 
		// /usr/local/share/cscout/, this assumption will break.
		return `${dir}${separator}${scriptPath}`;
	}

	return scriptPath;
}

/*
 * Check if a required dependency exists in the system PATH (or as an absolute path).
 * Throws a friendly error message if it doesn't exist, which bubbles up to the UI.
 */
export async function checkDependency(command: string, friendlyMessage: string, commandRunsInWsl: boolean): Promise<void> {
	if (!command) return;

	try {
		if (command.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(command)) {
			// Absolute path: check if it exists using standard fs
			const fs = require('fs');
			if (!fs.existsSync(command) && !fs.existsSync(`${command}.exe`)) {
				throw new Error();
			}
			return;
		}

		if (commandRunsInWsl) {
			await execFileAsync('wsl.exe', ['-e', 'which', command]);
		} else if (detectPlatform() === 'win32-native') {
			await execFileAsync('where.exe', [command]);
		} else {
			await execFileAsync('which', [command]);
		}
	} catch {
		throw new Error(friendlyMessage);
	}
}
