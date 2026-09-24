import './testMocks';
import { MockDocument, MockPosition } from './testMocks';
import * as fs from 'fs';



// Now import target files
import { CScoutClient } from './cscoutClient';
import { toEditorPath } from './platform';
import { IdentifierResolver } from './identifierResolver';
import {
    CScoutHoverProvider,
    CScoutCodeLensProvider,
    IdentifierTreeProvider
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
    await test('server is reachable', async () => {
        const status = await client.isAlive(); assert(status === true, 'Server not alive');
    });

    // --- Platform WSL Path Tests ---
    // --- Build System Detection Tests ---
    // --- API Count and Pagination Tests ---
    await test('GET /identifiers/counts returns counts', async () => {
        const counts = await client.getIdentifierCounts();
        assert(typeof counts.all === 'number' && counts.all > 0, 'all not a positive number');
        assert(typeof counts.unused_project === 'number', 'unused_project not a number');
    });

    await test('GET /functions/counts returns counts', async () => {
        const counts = await client.getFunctionCounts();
        assert(typeof counts.all === 'number' && counts.all > 0, 'all not a positive number');
        assert(typeof counts.project_scoped === 'number', 'project_scoped not a number');
    });

    await test('GET /files/counts returns counts', async () => {
        const counts = await client.getFileCounts();
        assert(typeof counts.all === 'number' && counts.all > 0, 'all not a positive number');
        assert(typeof counts.writable === 'number', 'writable not a number');
    });

    await test('GET /functions/byname works', async () => {
        const fn = await client.getFunctionByName('checkdup');
        assert(fn !== null, 'checkdup not found');
        assert(fn!.NAME === 'checkdup', 'wrong name returned');
        assert(typeof fn!.CCYCL1 === 'number', 'CCYCL1 missing or not number');
    });

    await test('pagination on functions works', async () => {
        const page1 = await client.getFunctions({ limit: 5, offset: 0 });
        const page2 = await client.getFunctions({ limit: 5, offset: 5 });
        assert(page1.length === 5, `Expected 5 items, got ${page1.length}`);
        assert(page2.length === 5, `Expected 5 items, got ${page2.length}`);
        assert(page1[0].ID !== page2[0].ID, 'Page 1 and Page 2 are identical (offset ignored)');
    });

    await test('pagination on identifiers works', async () => {
        const page1 = await client.getIdentifiers({ limit: 5, offset: 0 });
        const page2 = await client.getIdentifiers({ limit: 5, offset: 5 });
        assert(page1.length === 5, `Expected 5 items, got ${page1.length}`);
        assert(page2.length === 5, `Expected 5 items, got ${page2.length}`);
        assert(page1[0].EID !== page2[0].EID, 'Page 1 and Page 2 are identical (offset ignored)');
    });

    // --- Mock Provider Unit Tests ---
    await test('Hover Provider returns function complexity', async () => {
        const resolver = new IdentifierResolver(() => client, { appendLine: () => { } } as any);
        const hoverProvider = new CScoutHoverProvider(resolver, () => false);
        const doc = new MockDocument({ fsPath: 'awk/awk.c' }, 'void checkdup() {}');
        const pos = new MockPosition(0, 5);
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) };

        const hover: any = await hoverProvider.provideHover(doc as any, pos as any, token as any);
        assert(hover !== undefined, 'Hover was undefined');
        const contentStr = hover.contents[0].value;
        assert(contentStr.includes('checkdup'), 'Hover title checkdup not found');
        assert(contentStr.includes('complexity'), 'Hover complexity not found');
    });

    await test('CodeLens Provider returns lenses for active file', async () => {
        const dummyChannel = { appendLine: () => {} } as any;
        const codeLensProvider = new CScoutCodeLensProvider(() => client, dummyChannel);
        const files = await client.getFiles();
        const mainFile = files.find(f => f.NAME.endsWith('main.c'));
        assert(mainFile !== undefined, 'main.c not found in files list');

        const pathInDoc = toEditorPath(mainFile!.NAME);
        const realContent = fs.readFileSync(pathInDoc, 'utf-8');
        const doc = new MockDocument({ fsPath: pathInDoc }, realContent);

        const token = { isCancellationRequested: false };
        const lenses = await codeLensProvider.provideCodeLenses(doc as any, token as any);
        assert(Array.isArray(lenses), 'Lenses not an array');
        assert(lenses.length > 0, `No lenses returned for ${pathInDoc}`);
        const lens = lenses[0];
        assert(lens.command !== undefined, 'Lens missing command');
        const cmd = lens.command;
        assert(cmd !== undefined, 'Lens command is undefined');
        if (cmd) {
            assert(cmd.title.includes('caller'), 'Lens missing callers/callees title');
            assert(cmd.command === 'cscout.showCallGraph', 'Wrong lens command');
        }
    });

    const mockContext = { extensionPath: '', asAbsolutePath: (p: string) => p } as any;

    await test('Tree View Providers load top-level counts', async () => {
        const idTree = new IdentifierTreeProvider(() => client, mockContext);
        const rootNodes = await idTree.getChildren();
        assert(rootNodes.length > 0, 'No root nodes returned');
        const firstGroup = rootNodes[0];
        assert(firstGroup.kind === 'group', 'First node is not a group');
        if (firstGroup.kind === 'group') {
            assert(firstGroup.count !== undefined && firstGroup.count > 0, 'Group count missing or 0');
        }
    });

    await test('Tree View Providers paginate children correctly', async () => {
        const idTree = new IdentifierTreeProvider(() => client, mockContext);
        const rootNodes = await idTree.getChildren();
        const allGroup = rootNodes.find(n => n.kind === 'group' && n.groupKey === 'all');
        assert(allGroup !== undefined, 'All group not found');

        const firstPage = await idTree.getChildren(allGroup);
        assert(firstPage.length > 0, 'First page of identifiers is empty');

        // Assert that the page is capped at 200 items (or 201 with the load more action)
        assert(firstPage.length <= 201, `Page size is too large: ${firstPage.length}`);

        const loadMoreNode = firstPage.find(n => n.kind === 'load-more');
        assert(loadMoreNode !== undefined, 'Load-more node missing');
        if (loadMoreNode && loadMoreNode.kind === 'load-more') {
            assert(loadMoreNode.offset === 200, `Expected offset 200, got ${loadMoreNode.offset}`);
        }
    });

    // --- Original Integration Tests ---
    await test('GET /identifiers returns array', async () => {
        const ids = await client.getIdentifiers();
        assert(Array.isArray(ids), 'Not an array');
        assert(ids.length > 0, 'Empty array');
    });

    await test('identifiers have required fields', async () => {
        const ids = await client.getIdentifiers();
        const id = ids[0];
        assert(typeof id.EID === 'number', 'eid not string');
        assert(typeof id.NAME === 'string', 'name not string');
        assert(typeof id.UNUSED === 'number', 'unused not boolean');
        assert(typeof id.MACRO === 'number', 'macro not boolean');
        assert(typeof id.FUN === 'number', 'fun not boolean');
        assert(typeof id.READONLY === 'number', 'readonly not boolean');
    });

    await test('unused identifiers exist', async () => {
        const ids = await client.getIdentifiers();
        const unused = ids.filter(i => i.UNUSED);
        assert(unused.length > 0, 'No unused identifiers');
    });

    await test('GET /identifier returns locations', async () => {
        const ids = await client.getIdentifiers();
        const detail = await client.getIdentifier(ids[0].EID);
        assert(typeof detail.identifier.EID === 'number', 'eid not string');
        assert(Array.isArray(detail.locations), 'locations not array');
    });

    await test('GET /api/files returns array', async () => {
        const files = await client.getFiles();
        assert(Array.isArray(files), 'Not an array');
    });

    await test('files have required fields', async () => {
        const files = await client.getFiles();
        const f = files[0];
        assert(typeof f.FID === 'number', 'fid not number');
        assert(typeof f.NAME === 'string', 'name not string');
    });

    await test('GET /api/filemetrics returns metrics', async () => {
        const files = await client.getFiles();
        const metricsArr = await client.getFilemetrics(files[0].FID);
        const metrics = metricsArr[0];
        assert(Array.isArray(metricsArr), 'not array');
        assert(typeof metrics.FID === 'number', 'FID not number');
    });

    await test('GET /api/functions returns array', async () => {
        const funs = await client.getFunctions();
        assert(Array.isArray(funs), 'Not an array');
    });

    await test('functions have required fields', async () => {
        const funs = await client.getFunctions();
        const f = funs[0];
        assert(typeof f.ID === 'number', 'id not string');
        assert(typeof f.NAME === 'string', 'name not string');
    });

    await test('GET /api/funcs?callers returns array', async () => {
        const funs = await client.getFunctions({ limit: 100 });
        const withCallers = funs.find(f => f.FANIN > 0);
        assert(withCallers !== undefined, 'No function with callers');
        const callers = await client.getCallers(withCallers!.ID);
        assert(Array.isArray(callers), 'Not an array');
    });

    await test('GET /api/funcs?callees returns array', async () => {
        const funs = await client.getFunctions({ limit: 100 });
        const withCallees = funs.find(f => f.FANIN > 0);
        assert(withCallees !== undefined, 'No function with callees');
        const callees = await client.getCallees(withCallees!.ID);
        assert(Array.isArray(callees), 'Not an array');
    });

    await test('GET /api/projects returns array', async () => {
        const projects = await client.getProjects();
        assert(Array.isArray(projects), 'Not an array');
    });

    await test('GET /api/funmetrics returns metrics', async () => {
        const funs = await client.getFunctions({ limit: 100 });
        const checkdup = funs.find(f => f.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const metrics = await client.getFunmetrics(checkdup!.ID);
        assert(Array.isArray(metrics), 'not array');
    });

    await test('GET /api/refactor returns preview', async () => {
        const ids = await client.getIdentifiers({ name: 'checkdup', limit: 5 });
        const checkdup = ids.find(i => i.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const preview = await client.previewRename(checkdup!.EID, 'check_dup');
        assert(preview.old_name === 'checkdup', 'wrong old name');
        assert(preview.new_name === 'check_dup', 'wrong new name');
    });

    // --- Summary ---
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});