import './testMocks';
import { setMockInfoMessageChoice, getActiveWatcher, getActiveStatusBar, mockVSCode, MockDocument, MockPosition } from './testMocks';
import * as path from 'path';
import * as fs from 'fs';

// Now import target files
import { toWslPath, fromWslPath } from './platform';
import { detectAll } from './buildSystem';
import { buildTokenMap, chooseLineCandidate, diffRange, pickFunction, TokenMap } from './identity';
import { CScoutFileTokens, CScoutHoverFunction } from './cscoutClient';
import { CScoutLifecycle } from './lifecycle';
import {
    activate,
    CScoutHoverProvider
} from './extension';



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
        let resolved = false;
        const resolver = { resolve: async () => { resolved = true; return undefined; } };
        const hoverProvider = new CScoutHoverProvider(resolver as any, () => false);
        const doc = new MockDocument({ fsPath: 'awk/awk.c' }, 'void checkdup() {}');
        const pos = new MockPosition(0, 5);
        const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => { } }) };

        const hover = await hoverProvider.provideHover(doc as any, pos as any, token as any);
        assert(hover === undefined, 'Hover was not cancelled');
        assert(!resolved, 'Hover looked up the identifier after cancellation');
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


    // --- Identifier identity (token map) ---

    // A file as CScout would record it: tokens gives [byte offset, name]
    // for every identifier token, and each distinct EID gets an index.
    function tokensFor(fid: number, tokens: [number, string, number][]): CScoutFileTokens {
        const eids: number[] = [];
        const names: string[] = [];
        const flat: number[] = [];
        for (const [off, name, eid] of tokens) {
            let k = eids.indexOf(eid);
            if (k < 0) { k = eids.length; eids.push(eid); names.push(name); }
            flat.push(off, k);
        }
        return { fid, eids, names, tokens: flat };
    }

    // Byte offsets of every occurrence of name in text, as CScout records them.
    function bytesAt(text: string, name: string): number[] {
        const out: number[] = [];
        for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
            out.push(Buffer.byteLength(text.slice(0, i), 'utf8'));
        }
        return out;
    }

    // Look up the whole word containing offset `at`, cursor at `at`.
    function lookupAt(map: TokenMap, text: string, at: number) {
        let s = at, e = at;
        while (s > 0 && /\w/.test(text[s - 1])) s--;
        while (e < text.length && /\w/.test(text[e])) e++;
        return map.lookup(s, e, at);
    }

    const three = 'struct s { int s; } s;\nint x;\n';
    const threeTokens = tokensFor(1, [[7, 's', 100], [15, 's', 200], [20, 's', 300], [27, 'x', 400]]);

    await test('Token map tells three same-named identifiers on one line apart', async () => {
        const map = buildTokenMap(threeTokens, Buffer.from(three), three);
        const got = [7, 15, 20].map((o) => lookupAt(map, three, o));
        assert(got.every((g) => g.kind === 'exact'), 'expected exact matches');
        const eids = got.map((g) => (g as any).eid);
        assert(eids.join() === '100,200,300', `wrong identities: ${eids.join()}`);
        assert(!map.modified, 'unchanged file reported as modified');
    });

    await test('Token map reports none for keywords and unrecorded words', async () => {
        const map = buildTokenMap(threeTokens, Buffer.from(three), three);
        assert(lookupAt(map, three, 0).kind === 'none', 'keyword "struct" should be none');
        assert(lookupAt(map, three, 11).kind === 'none', 'keyword "int" should be none');
    });

    await test('Token map follows an edit above the identifier exactly', async () => {
        const map = buildTokenMap(threeTokens, Buffer.from(three), three);
        const inserted = '/* new comment */\n';
        map.applyChange(0, 0, inserted.length);
        const now = inserted + three;
        const g = lookupAt(map, now, inserted.length + 15);
        assert(g.kind === 'exact' && g.eid === 200, `expected the member s (200), got ${JSON.stringify(g)}`);
        assert(map.modified, 'edited map should report modified');
    });

    await test('Token map treats a renamed-in-place token as unknown', async () => {
        const text = 'int count;\n';
        const map = buildTokenMap(tokensFor(1, [[4, 'count', 7]]), Buffer.from(text), text);
        map.applyChange(6, 0, 1);                              // co|unt -> coXunt
        assert(lookupAt(map, 'int coXunt;\n', 5).kind === 'unknown', 'edit inside a name must not match');
    });

    await test('Token map keeps a token when a space is typed after it', async () => {
        const text = 'int count;\n';
        const map = buildTokenMap(tokensFor(1, [[4, 'count', 7]]), Buffer.from(text), text);
        map.applyChange(9, 0, 1);                              // "count ;"
        const g = lookupAt(map, 'int count ;\n', 5);
        assert(g.kind === 'exact' && g.eid === 7, 'space after a name should keep it exact');
    });

    await test('Token map treats letters typed onto a name as unknown', async () => {
        const text = 'int count;\n';
        const map = buildTokenMap(tokensFor(1, [[4, 'count', 7]]), Buffer.from(text), text);
        map.applyChange(9, 0, 2);                              // count -> counter
        assert(lookupAt(map, 'int counter;\n', 5).kind === 'unknown', 'count -> counter must not match count');
    });

    await test('Token map treats two words joined by a deletion as unknown', async () => {
        const text = 'a b;\n';
        const map = buildTokenMap(tokensFor(1, [[0, 'a', 1], [2, 'b', 2]]), Buffer.from(text), text);
        map.applyChange(1, 1, 0);                              // "a b" -> "ab"
        assert(lookupAt(map, 'ab;\n', 0).kind === 'unknown', 'joined word must not match a or b');
    });

    await test('Token map resolves each part of a split identifier', async () => {
        // CScout records alpha_impl as alpha + _impl when the name is
        // also built by token pasting (n ## _impl) elsewhere.
        const text = 'int alpha_impl(void);\n';
        const map = buildTokenMap(tokensFor(1, [[4, 'alpha', 10], [9, '_impl', 20]]), Buffer.from(text), text);
        const first = lookupAt(map, text, 6);
        const second = lookupAt(map, text, 11);
        assert(first.kind === 'exact' && first.eid === 10 && first.start === 4 && first.end === 9, 'cursor on alpha');
        assert(second.kind === 'exact' && second.eid === 20 && second.start === 9, 'cursor on _impl');
    });

    await test('Token map stops trusting a file changed on disk after analysis', async () => {
        // Analyzed text: "int a; int b;". The file on disk now has a
        // line inserted between them, so b's recorded offset is wrong.
        const analyzedTokens = tokensFor(1, [[4, 'a', 1], [11, 'b', 2]]);
        const disk = 'int a;\nint zz; int b;';
        const map = buildTokenMap(analyzedTokens, Buffer.from(disk), disk);
        assert(lookupAt(map, disk, 4).kind === 'exact', 'a is before the change and still exact');
        assert(lookupAt(map, disk, 15).kind === 'unknown', 'b after the change must be unknown');
        assert(map.modified, 'changed file should report modified');
    });

    await test('Token map applies unsaved edits on top of the analyzed file', async () => {
        const disk = 'int a;\nint b;\n';
        const unsaved = '// top\nint a;\nint b;\n';
        const map = buildTokenMap(tokensFor(1, [[4, 'a', 1], [11, 'b', 2]]), Buffer.from(disk), unsaved);
        const g = lookupAt(map, unsaved, unsaved.indexOf('b'));
        assert(g.kind === 'exact' && g.eid === 2, 'b should be found at its shifted position');
    });

    await test('Token map converts byte offsets past CRLF and UTF-8 text', async () => {
        // "é" is 2 bytes but 1 character; "𝒳" is 4 bytes but 2 UTF-16 units.
        const text = '// café 𝒳\r\nint value;\r\nint other;\r\n';
        const t = tokensFor(1, [[bytesAt(text, 'value')[0], 'value', 5], [bytesAt(text, 'other')[0], 'other', 6]]);
        const map = buildTokenMap(t, Buffer.from(text, 'utf8'), text);
        const v = lookupAt(map, text, text.indexOf('value'));
        const o = lookupAt(map, text, text.indexOf('other'));
        assert(v.kind === 'exact' && v.eid === 5 && v.start === text.indexOf('value'), `value: ${JSON.stringify(v)}`);
        assert(o.kind === 'exact' && o.eid === 6, 'other');
        assert(!map.modified, 'unchanged file reported as modified');
    });

    await test('Token map lists an identifier\'s current occurrences', async () => {
        const text = 'int n; n = n + 1;\n';
        const offs = [4, 7, 11];
        const map = buildTokenMap(tokensFor(1, offs.map((o) => [o, 'n', 9] as [number, string, number])), Buffer.from(text), text);
        map.applyChange(0, 0, 3);
        const ranges = map.rangesOf(9).map(([s]) => s).join();
        assert(ranges === '7,10,14', `shifted ranges wrong: ${ranges}`);
    });

    await test('diffRange finds the single changed span', async () => {
        const [at, removed, inserted] = diffRange('int a; int b;', 'int a; long b;');
        assert(at === 7 && removed === 3 && inserted === 4, `got ${at},${removed},${inserted}`);
    });

    await test('chooseLineCandidate matches by column only when needed', async () => {
        const one = chooseLineCandidate([{ EID: 1, COLUMN: 3 }, { EID: 1, COLUMN: 9 }], 99);
        assert(one?.eid === 1 && !one.byColumn, 'one identifier on the line');
        const byCol = chooseLineCandidate([{ EID: 1, COLUMN: 7 }, { EID: 2, COLUMN: 15 }], 15);
        assert(byCol?.eid === 2 && byCol.byColumn, 'pick by column');
        assert(chooseLineCandidate([{ EID: 1, COLUMN: 7 }, { EID: 2, COLUMN: 15 }], 11) === undefined, 'no guess');
    });

    function fn(id: number, defFid: number | null, defOff: number | null, fanin: number, ccycl: number): CScoutHoverFunction {
        return {
            ID: id, NAME: 'f', ISMACRO: 0, DEFINED: defFid === null ? 0 : 1, FILESCOPED: 0, FANIN: fanin,
            FANOUT: 0, CCYCL1: ccycl, CCYCL1_PRE: ccycl, DEF_FID: defFid, DEF_FOFFSET: defOff, DEF_FILE: 'f.c', DEF_LNUM: 1,
        };
    }

    await test('pickFunction treats per-project copies as one definition', async () => {
        const pick = pickFunction([fn(1, 5, 100, 123, 3), fn(2, 5, 100, 442, 3)], undefined);
        assert(pick.kind === 'one' && pick.fn.ID === 2, 'expected one definition, the record with most callers');
    });

    await test('pickFunction prefers the definition in the current file, else declines', async () => {
        const defs = [fn(1, 5, 100, 1, 2), fn(2, 6, 40, 1, 7)];
        const here = pickFunction(defs, 6);
        assert(here.kind === 'one' && here.fn.ID === 2, 'definition in the current file');
        assert(pickFunction(defs, 9).kind === 'ambiguous', 'no definition here: ambiguous, not a guess');
        assert(pickFunction([fn(3, null, null, 0, 0)], 5).kind === 'none', 'declared only');
    });

    // --- Summary ---
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});