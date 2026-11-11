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
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	commandRunsInWsl,
	pathForCommand,
	resolveCommand,
	resolveScriptPath,
	checkDependency,
} from './platform';

export type BuildSystem =
	| 'existing-cs'
	| 'compile-commands'
	| 'makefile'
	| 'cmake'
	| 'meson'
	| 'autotools'
	| 'unknown';

export interface BuildResult {
	csFilePath: string;
	projectName: string;
	buildSystem: BuildSystem;
	fileCount: number;
}

export interface CScoutSettings {
	host: string;
	port: number;
	cscoutBinaryPath: string;
	cscocoPyPath: string;
	csapiPyPath: string;
	csmakePath: string;
	pythonPath: string;
	sqlite3Path: string;
	autoStart: boolean;
	projectName?: string;
}

export interface DetectedBuildSystems {
	hasCs: boolean;
	hasCompileCommands: boolean;
	compileCommandsPath?: string;
	hasMakefile: boolean;
	hasCMake: boolean;
	hasMeson: boolean;
	hasAutotools: boolean;
	existingCsFiles: string[];
}

/*
 * Look for build descriptor files in the workspace root.  We use fs
 * directly rather than vscode.workspace.findFiles to avoid path-scheme
 * ambiguity across platforms - findFiles behaves differently for WSL
 * mounts vs native filesystem.
 */
export function detectAll(workspaceRoot: string): DetectedBuildSystems {
	const exists = (name: string): boolean => {
		try {
			return fs.existsSync(path.join(workspaceRoot, name));
		} catch {
			return false;
		}
	};

	let existingCsFiles: string[] = [];
	try {
		existingCsFiles = fs
			.readdirSync(workspaceRoot)
			.filter((f) => f.endsWith('.cs'))
			.map((f) => path.join(workspaceRoot, f));
	} catch {
		/* directory unreadable - leave list empty */
	}

	let compileCommandsPath: string | undefined;
	if (exists('compile_commands.json')) {
		compileCommandsPath = path.join(workspaceRoot, 'compile_commands.json');
	} else if (exists(path.join('build', 'compile_commands.json'))) {
		compileCommandsPath = path.join(workspaceRoot, 'build', 'compile_commands.json');
	}

	return {
		hasCs: existingCsFiles.length > 0,
		hasCompileCommands: compileCommandsPath !== undefined,
		compileCommandsPath,
		hasMakefile: exists('Makefile') || exists('makefile'),
		hasCMake: exists('CMakeLists.txt'),
		hasMeson: exists('meson.build'),
		hasAutotools: exists('configure.ac') || exists('configure'),
		existingCsFiles,
	};
}

/*
 * Count '#pragma process' directives in a .cs file - reflects the number
 * of translation units CScout will analyze.  Used for the post-generation
 * notification so the user sees what was captured.
 */
function countProcessedFiles(csFilePath: string): number {
	try {
		const content = fs.readFileSync(csFilePath, 'utf-8');
		return (content.match(/#pragma\s+process/g) || []).length;
	} catch {
		return 0;
	}
}

/*
 * Spawn a command and stream its output to the channel.  Resolves on
 * exit code 0, rejects otherwise with the collected stderr.
 */
function spawnStreaming(
	command: string,
	args: string[],
	cwd: string,
	channel: vscode.OutputChannel,
	// TODO: check if dead code.
	onStdoutLine?: (line: string) => void
): Promise<string> {
	return new Promise((resolve, reject) => {
		const resolved = resolveCommand(command, args);
		channel.appendLine(`$ ${resolved.command} ${resolved.args.join(' ')}`);
		channel.appendLine(`  (cwd: ${cwd})`);

		const proc = cp.spawn(resolved.command, resolved.args, {
			cwd,
			shell: false,
		});

		let stderr = '';
		let stdout = '';
		let lineBuffer = '';

		proc.stdout?.on('data', (data: Buffer) => {
			const text = data.toString();
			stdout += text;
			if (onStdoutLine) {
				lineBuffer += text;
				const lines = lineBuffer.split('\n');
				lineBuffer = lines.pop() || '';
				for (const line of lines) {
					onStdoutLine(line);
				}
			}
		});

		proc.stderr?.on('data', (data: Buffer) => {
			const text = data.toString();
			stderr += text;
			channel.append(text);
		});

		proc.on('error', (err) => {
			channel.appendLine(`  error: ${err.message}`);
			reject(err);
		});

		proc.on('exit', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`${command} exited with code ${code}\n${stderr}`));
			}
		});
	});
}

/*
 * Present a choice to the user when a build system is detected. Whenever
 * this function runs, it always shows the prompt and waits for the user.
 * It's generateCsFile that decides whether to call this at all, see the
 * TODO on its previousBuildResult param for the one way that gets skipped.
 */
async function askUserAboutBuildSystem(
	detected: DetectedBuildSystems
): Promise<{ choice: BuildSystem; existingCs?: string } | undefined> {
	// Priority: existing .cs first, then compile_commands, then build systems.
	if (detected.hasCs) {
		const message =
			detected.existingCsFiles.length === 1
				? `Found existing workspace file ${path.basename(detected.existingCsFiles[0])}. Use it?`
				: `Found ${detected.existingCsFiles.length} existing .cs workspace files.`;
		const useExisting = 'Use existing';
		const generateNew = 'Generate new';
		const choice = await vscode.window.showInformationMessage(
			message,
			{ modal: false },
			useExisting,
			generateNew
		);
		if (choice === useExisting) {
			const file =
				detected.existingCsFiles.length === 1
					? detected.existingCsFiles[0]
					: await pickCsFile(detected.existingCsFiles);
			if (file) {
				return { choice: 'existing-cs', existingCs: file };
			}
			return undefined;
		}
		if (choice !== generateNew) {
			return undefined;
		}
	}

	const options: { label: string; value: BuildSystem; description: string }[] = [];

	if (detected.hasCompileCommands) {
		options.push({
			label: 'compile_commands.json',
			value: 'compile-commands',
			description: 'Feed existing compilation database to cscoco',
		});
	}
	if (detected.hasCMake) {
		options.push({
			label: 'CMakeLists.txt',
			value: 'cmake',
			description: 'Run cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON, then cscoco',
		});
	}
	if (detected.hasMeson) {
		options.push({
			label: 'meson.build',
			value: 'meson',
			description: 'Run meson setup build, then cscoco',
		});
	}
	if (detected.hasMakefile) {
		options.push({
			label: 'Makefile',
			value: 'makefile',
			description: 'Run csmake to intercept the build',
		});
	}
	if (detected.hasAutotools) {
		options.push({
			label: 'configure.ac (Autotools)',
			value: 'autotools',
			description: 'Run ./configure to generate a Makefile, then csmake',
		});
	}
	options.push({
		label: 'Browse for existing .cs file',
		value: 'existing-cs',
		description: 'Locate a workspace file elsewhere on disk',
	});

	if (options.length === 1 && options[0].value === 'existing-cs') {
		vscode.window.showErrorMessage(
			'CScout could not detect your build system. Supported: existing .cs file, ' +
			'Makefile (via csmake), CMake, Meson, and Autotools. If your build system is not supported, ' +
			'you can generate compile_commands.json with Bear and CScout will use that.'
		);
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		options.map((o) => ({ label: o.label, description: o.description, value: o.value })),
		{
			title: 'CScout: Choose how to analyze this project',
			placeHolder: 'How would you like to generate the CScout workspace file?',
		}
	);

	if (!picked) {
		return undefined;
	}

	if (picked.value === 'existing-cs') {
		const file = await pickCsFile();
		if (file) {
			return { choice: 'existing-cs', existingCs: file };
		}
		return undefined;
	}

	return { choice: picked.value };
}

// If there's more than one existing .cs file, show a dropdown to pick one.
// With exactly one, or none, it doesn't just use that file automatically,
// it opens the OS file-browse dialog instead.
async function pickCsFile(candidates?: string[]): Promise<string | undefined> {
	if (candidates && candidates.length > 1) {
		const picked = await vscode.window.showQuickPick(
			candidates.map((c) => ({ label: path.basename(c), description: c, value: c })),
			{ title: 'Select .cs workspace file' }
		);
		return picked?.value;
	}

	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { 'CScout workspace': ['cs'] },
		openLabel: 'Use this workspace file',
	});
	return uris?.[0]?.fsPath;
}

/*
 * Given a chosen build system, run the necessary commands and return the
 * path to the resulting .cs file.  Progress and log output stream into
 * the CScout output channel.
 */
export async function generateCsFile(
	workspaceRoot: string,
	settings: CScoutSettings,
	channel: vscode.OutputChannel,
	progress?: vscode.Progress<{ message?: string; increment?: number }>,
	// TODO (immediate): this is dead today, the only caller always passes
	// undefined. But if it's ever wired up to pass a real value, this skips
	// askUserAboutBuildSystem entirely and runs cmake/meson/configure/csmake
	// silently, no confirmation prompt at all. Don't wire this up without
	// keeping that safety check, or CScout will start running build commands
	// on the user's machine without asking first.
	previousBuildResult?: BuildResult
): Promise<BuildResult> {
	const detected = detectAll(workspaceRoot);
	const projectName =
		settings.projectName || path.basename(workspaceRoot) || 'project';

	let answer: { choice: BuildSystem; existingCs?: string };
	
	if (previousBuildResult) {
		answer = {
			choice: previousBuildResult.buildSystem,
			existingCs: previousBuildResult.buildSystem === 'existing-cs' ? previousBuildResult.csFilePath : undefined
		};
	} else {
		const userChoice = await askUserAboutBuildSystem(detected);
		if (!userChoice) {
			throw new Error('User cancelled build system selection.');
		}
		answer = userChoice;
	}

	if (answer.choice === 'existing-cs' && answer.existingCs) {
		const fileCount = countProcessedFiles(answer.existingCs);
		if (!previousBuildResult) {
			vscode.window.showInformationMessage(
				`Using existing workspace file. ${fileCount} translation units will be analyzed.`
			);
		}
		return {
			csFilePath: answer.existingCs,
			projectName,
			buildSystem: 'existing-cs',
			fileCount,
		};
	}

	const csFilePath = path.join(workspaceRoot, `${projectName}.cs`);

	progress?.report({ message: 'Preparing compilation database...' });

	let compileCommandsPath: string | undefined;
	const inWsl = commandRunsInWsl(settings.cscoutBinaryPath);

	switch (answer.choice) {
		case 'compile-commands':
			compileCommandsPath = detected.compileCommandsPath;
			break;

		case 'cmake':
			channel.appendLine('--- Running CMake configure ---');
			await checkDependency('cmake', 'cmake not found. Please install it (e.g., sudo apt install cmake or brew install cmake) before using the CMake build system detection.', commandRunsInWsl('cmake'));
			try {
				await spawnStreaming(
					'cmake',
					['-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-B', 'build', '.'],
					workspaceRoot,
					channel
				);
			} catch (err) {
				const message = (err as Error).message;
				const missingDep = /Could NOT find (\w+)/.exec(message);
				if (missingDep) {
					throw new Error(
						`CMake configuration failed: missing system dependency "${missingDep[1]}". ` +
						`Install it (e.g. sudo apt install lib${missingDep[1].toLowerCase()}-dev) and try again, ` +
						`or choose a different project.`
					);
				}
				throw err;
			}
			compileCommandsPath = path.join(workspaceRoot, 'build', 'compile_commands.json');
			break;

		case 'meson':
			channel.appendLine('--- Running Meson setup ---');
			await spawnStreaming('meson', ['setup', 'build'], workspaceRoot, channel);
			compileCommandsPath = path.join(workspaceRoot, 'build', 'compile_commands.json');
			break;

		case 'makefile':
			channel.appendLine('--- Running csmake ---');
			const resolvedCsmake = await resolveScriptPath(settings.csmakePath, settings.cscoutBinaryPath, inWsl);
			await checkDependency(resolvedCsmake, 'csmake not found. Please ensure CScout is properly installed and csmake is in your PATH.', inWsl);
			await spawnStreaming(resolvedCsmake, [], workspaceRoot, channel);
			// csmake writes make.cs - rename it to <projectName>.cs.
			try {
				fs.renameSync(path.join(workspaceRoot, 'make.cs'), csFilePath);
			} catch {
				// If rename fails, fall back to the file csmake created.
				const fileCount = countProcessedFiles(path.join(workspaceRoot, 'make.cs'));
				return {
					csFilePath: path.join(workspaceRoot, 'make.cs'),
					projectName,
					buildSystem: 'makefile',
					fileCount,
				};
			}
			return {
				csFilePath,
				projectName,
				buildSystem: 'makefile',
				fileCount: countProcessedFiles(csFilePath),
			};

		case 'autotools':
			channel.appendLine('--- Running ./configure ---');
			// Try autogen.sh first if present.
			if (fs.existsSync(path.join(workspaceRoot, 'autogen.sh'))) {
				await spawnStreaming('sh', ['autogen.sh'], workspaceRoot, channel);
			}
			await spawnStreaming('sh', ['configure'], workspaceRoot, channel);
			channel.appendLine('--- Running csmake ---');
			const resolvedAutotoolsCsmake = await resolveScriptPath(settings.csmakePath, settings.cscoutBinaryPath, inWsl);
			await spawnStreaming(resolvedAutotoolsCsmake, [], workspaceRoot, channel);
			try {
				fs.renameSync(path.join(workspaceRoot, 'make.cs'), csFilePath);
			} catch {
				return {
					csFilePath: path.join(workspaceRoot, 'make.cs'),
					projectName,
					buildSystem: 'autotools',
					fileCount: countProcessedFiles(path.join(workspaceRoot, 'make.cs')),
				};
			}
			return {
				csFilePath,
				projectName,
				buildSystem: 'autotools',
				fileCount: countProcessedFiles(csFilePath),
			};

		default:
			throw new Error(`Unhandled build system: ${answer.choice}`);
	}

	if (!compileCommandsPath || !fs.existsSync(compileCommandsPath)) {
		throw new Error('compile_commands.json was not produced.');
	}

	progress?.report({ message: 'Generating workspace file with cscoco...' });
	channel.appendLine('--- Running cscoco ---');

	const pythonInWsl = commandRunsInWsl(settings.pythonPath);
	const resolvedCscoco = await resolveScriptPath(settings.cscocoPyPath, settings.cscoutBinaryPath, pythonInWsl);
	const cscocoArg = pathForCommand(resolvedCscoco, pythonInWsl);
	const ccArg = pathForCommand(compileCommandsPath, pythonInWsl);

	const cscocoOutput = await spawnStreaming(
		settings.pythonPath,
		[cscocoArg, '-n', projectName, ccArg],
		workspaceRoot,
		channel
	);
	fs.writeFileSync(csFilePath, cscocoOutput);

	const fileCount = countProcessedFiles(csFilePath);

	vscode.window.showInformationMessage(
		`Generated workspace file from ${answer.choice}. ${fileCount} C files will be analyzed. ` +
		'Note: files excluded from your build configuration are not included in the analysis.'
	);

	return {
		csFilePath,
		projectName,
		buildSystem: answer.choice,
		fileCount,
	};
}