import './testMocks';
import { setMockInfoMessageChoice, getActiveWatcher, getActiveStatusBar, mockVSCode, MockDocument, MockPosition } from './testMocks';
import * as path from 'path';
import * as fs from 'fs';

// Now import target files
import { CScoutClient } from './cscoutClient';
import { toWslPath, fromWslPath, resolveScriptPath } from './platform';
import { detectAll } from './buildSystem';
import { CScoutLifecycle } from './lifecycle';
import {
    activate,
    CScoutHoverProvider
} from './extension';

const client = new CScoutClient('localhost', 8081);


async function runTests() {
    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (err: any) {
            console.log(`✗ ${name}: ${err.message}`);
            failed++;
        }
    }

    function assert(condition: boolean, msg: string) {
        if (!condition) { throw new Error(msg); }
    }

    // --- Connection Tests ---
    // --- Platform WSL Path Tests ---
    await test('toWslPath translates Windows paths', async () => {
        const wsl = toWslPath('C:\\Users\\foo\\project');
        assert(wsl === '/mnt/c/Users/foo/project', `Expected /mnt/c/Users/foo/project, got ${wsl}`);
    });

    await test('fromWslPath translates WSL paths', async () => {
        const win = fromWslPath('/mnt/c/Users/foo/project');
        assert(win === 'C:\\Users\\foo\\project', `Expected C:\\Users\\foo\\project, got ${win}`);
    });

    await test('resolveScriptPath derives sibling tools directly from cscout binary path', async () => {
        const csapi = await resolveScriptPath('csapi.py', '/usr/local/bin/cscout', false);
        assert(csapi === '/usr/local/bin/csapi.py', `Expected /usr/local/bin/csapi.py, got ${csapi}`);

        const cscoco = await resolveScriptPath('cscoco.py', '/usr/local/bin/cscout', false);
        assert(cscoco === '/usr/local/bin/cscoco.py', `Expected /usr/local/bin/cscoco.py, got ${cscoco}`);

        const csmake = await resolveScriptPath('csmake', '/usr/local/bin/cscout', false);
        assert(csmake === '/usr/local/bin/csmake', `Expected /usr/local/bin/csmake, got ${csmake}`);
    });

    // --- Build System Detection Tests ---
    await test('detectAll detects CMake project', async () => {
        const tempDir = path.join(__dirname, 'temp_cmake_test');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        fs.writeFileSync(path.join(tempDir, 'CMakeLists.txt'), 'project(test)');
        fs.writeFileSync(path.join(tempDir, 'compile_commands.json'), '[]');

        const detected = detectAll(tempDir);
        fs.unlinkSync(path.join(tempDir, 'CMakeLists.txt'));
        fs.unlinkSync(path.join(tempDir, 'compile_commands.json'));
        fs.rmdirSync(tempDir);

        assert(detected.hasCMake === true, 'CMake lists not detected');
        assert(detected.hasCompileCommands === true, 'Compile commands not detected');
    });

    await test('detectAll detects Meson project', async () => {
        const tempDir = path.join(__dirname, 'temp_meson_test');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        fs.writeFileSync(path.join(tempDir, 'meson.build'), 'project()');

        const detected = detectAll(tempDir);
        fs.unlinkSync(path.join(tempDir, 'meson.build'));
        fs.rmdirSync(tempDir);

        assert(detected.hasMeson === true, 'Meson project not detected');
    });

    await test('detectAll detects Makefile project', async () => {
        const tempDir = path.join(__dirname, 'temp_make_test');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        fs.writeFileSync(path.join(tempDir, 'Makefile'), 'all:');

        const detected = detectAll(tempDir);
        fs.unlinkSync(path.join(tempDir, 'Makefile'));
        fs.rmdirSync(tempDir);

        assert(detected.hasMakefile === true, 'Makefile not detected');
    });

    // --- API Count and Pagination Tests ---
    // --- Mock Provider Unit Tests ---
    await test('Hover Provider respects cancellation', async () => {
        const hoverProvider = new CScoutHoverProvider(() => client);
        const doc = new MockDocument({ fsPath: 'awk/awk.c' }, 'void checkdup() {}');
        const pos = new MockPosition(0, 5);
        const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => { } }) };

        const hover = await hoverProvider.provideHover(doc as any, pos as any, token as any);
        assert(hover === undefined, 'Hover was not cancelled');
    });

    // --- Original Integration Tests ---
    await test('File Watcher detects file changes and updates status bar & prompts re-analysis', async () => {
        // 1. Mock setTimeout to execute immediately
        const originalSetTimeout = global.setTimeout;
        (global as any).setTimeout = (fn: any, delay: number) => {
            const targetDelay = delay === 10000 ? 1 : delay;
            return originalSetTimeout(fn, targetDelay);
        };

        try {
            // 2. Intercept command execution to verify if cscout.reanalyze is triggered
            const reanalyzeState = { called: false };
            let mockCommandRegistered: any = undefined;

            const originalRegister = mockVSCode.commands.registerCommand;
            mockVSCode.commands.registerCommand = (cmd: string, fn: any) => {
                if (cmd === 'cscout.reanalyze') {
                    mockCommandRegistered = fn;
                }
                return originalRegister(cmd, fn);
            };

            const originalExecute = mockVSCode.commands.executeCommand;
            mockVSCode.commands.executeCommand = (cmd: string, ...args: any[]) => {
                if (cmd === 'cscout.reanalyze') {
                    reanalyzeState.called = true;
                    assert(getActiveStatusBar()!.text.includes('stale'), `Status bar should be stale when reanalyze is requested, got: ${getActiveStatusBar()!.text}`);
                    if (mockCommandRegistered) {
                        return mockCommandRegistered();
                    }
                }
                return originalExecute(cmd, ...args);
            };

            // 3. Mock CScoutLifecycle to control state transitions
            const originalStart = CScoutLifecycle.prototype.start;
            const originalReanalyze = CScoutLifecycle.prototype.reanalyze;

            CScoutLifecycle.prototype.start = async function (this: any) {
                this.events.onStateChange('analyzing', undefined);
                this.events.onStateChange('ready', undefined);
            };

            CScoutLifecycle.prototype.reanalyze = async function (this: any) {
                this.events.onStateChange('analyzing', undefined);
                this.events.onStateChange('ready', undefined);
            };

            // 4. Activate the extension (this registers the file watcher and status bar)
            const subscriptions: any[] = [];
            const mockContext = {
                subscriptions,
                globalState: {
                    get: () => true,
                    update: () => Promise.resolve()
                }
            };

            activate(mockContext as any);

            // 5. Transition to ready state
            await mockVSCode.commands.executeCommand('cscout.start');
            assert(getActiveStatusBar() !== undefined, 'Status bar not initialized');
            assert(getActiveStatusBar()!.text.includes('CScout'), 'Status bar should show CScout ready');

            // 6. Simulate a file change
            assert(getActiveWatcher() !== undefined, 'File watcher not initialized');

            setMockInfoMessageChoice('Re-analyze');
            getActiveWatcher()!.fireChange({ fsPath: 'main.c' } as any);

            // Wait a small amount for the debounced timeout to execute
            await new Promise(resolve => originalSetTimeout(resolve, 5));

            // Verify that reanalyze was triggered
            assert(reanalyzeState.called === true, 'Re-analyze command should be triggered');

            // 7. Verify status bar returns to clean state after re-analysis
            assert(!getActiveStatusBar()!.text.includes('stale'), 'Status bar should clear stale status after re-analysis');

            // 8. Test ignore choice
            reanalyzeState.called = false;
            // Transition back to ready
            await mockVSCode.commands.executeCommand('cscout.start');
            // Fire change again
            setMockInfoMessageChoice('Ignore');
            getActiveWatcher()!.fireChange({ fsPath: 'main.c' } as any);

            await new Promise(resolve => originalSetTimeout(resolve, 5));
            assert(getActiveStatusBar()!.text.includes('stale'), 'Status bar should be stale');
            assert(reanalyzeState.called === false, 'Re-analyze should not be called when ignored');

            // Clean up subscriptions
            for (const sub of subscriptions) {
                if (typeof sub.dispose === 'function') sub.dispose();
            }

            // Restore prototypes
            CScoutLifecycle.prototype.start = originalStart;
            CScoutLifecycle.prototype.reanalyze = originalReanalyze;
            mockVSCode.commands.executeCommand = originalExecute;
            mockVSCode.commands.registerCommand = originalRegister;

        } finally {
            // Restore setTimeout
            global.setTimeout = originalSetTimeout;
        }
    });

    // --- Summary ---
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});