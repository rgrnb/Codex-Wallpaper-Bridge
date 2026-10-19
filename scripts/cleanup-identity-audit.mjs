import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/platform.mjs';
import { ProcessSampler } from '../src/metrics.mjs';
import { cleanupProcessLedger, runtimeCleanupEvidence } from './independent-evidence.mjs';

// Read-only supplement; never edits the original failed result, kills a
// process, or turns a real resource/lifecycle failure into a pass.
const argument = process.argv.find(value => value.startsWith('--report='));
assert.ok(argument); const original = path.resolve(argument.slice(9)), allowed = path.join(ROOT, '.local-evidence');
assert.ok(original.startsWith(allowed + path.sep));
const bytes = await readFile(original), report = JSON.parse(bytes);
assert.equal(report.failure?.code, 'INDEPENDENT_CLEANUP_FAILED');
assert.equal(report.endurance?.completed, true, 'All original resource gates must already have passed.');
const evidence = path.join(allowed, `cleanup-identity-audit-${randomUUID()}`); await mkdir(evidence);
const result = { success: false, original, originalSha256: createHash('sha256').update(bytes).digest('hex'),
  originalSuccess: report.success, originalFailure: report.failure,
  scope: 'Read-only exact-identity supplement to the preserved original report; no PID termination or original-result mutation.' };
try {
  assert.ok(!report.cleanupError && !report.cleanupSnapshotError);
  assert.ok(report.cleanup.workerExits.every(worker => worker.exited));
  assert.ok(!report.cleanup.nativeOpened && !report.cleanup.ownedRootsAlive.length);
  assert.ok(report.cleanup.userPidsRetained && report.cleanup.desktopUnchanged);
  assert.ok(report.restoredOwnedNodes.every(count => count === 0));
  assert.ok(report.sourcePreservation.every(row => row.changes?.contentUnchanged && row.changes?.metadataUnchanged));
  assert.ok(report.terminatedOwnedTrees.every(tree => tree.alreadyExited || (tree.identityVerified && !tree.skipped.length && tree.processes.every(row => row.exited))));
  const history = [...report.performance.flatMap(sample => [...sample.helperBaseline.counters, ...sample.captureHelpers.counters]),
    ...report.endurance.samples.flatMap(sample => [...sample.codexTree.counters, ...sample.activeHelpers.counters])];
  const sampler = new ProcessSampler({ details: true, scope: 'exact-owned-cleanup-identity-audit' });
  const ledger = await cleanupProcessLedger({ sampler, workers: [], history });
  result.rejectedPidReuse = report.cleanup.remainingHelpers.map(row => ({ observed: row,
    originalIdentities: [...ledger.values()].filter(original => original.pid === row.pid),
    measuredOwnedIdentity: ledger.has(`${row.pid}:${row.identity}`) }));
  assert.ok(result.rejectedPidReuse.length > 0 && result.rejectedPidReuse.every(row => !row.measuredOwnedIdentity && row.originalIdentities.length > 0));
  const pids = [...new Set([...ledger.values()].map(row => row.pid))], current = [];
  for (let index = 0; index < pids.length; index += 8) current.push(...(await sampler.collect(pids.slice(index, index + 8))).counters);
  result.measuredOriginalIdentities = ledger.size;
  result.remainingOwnedIdentities = current.filter(row => ledger.has(`${row.pid}:${row.identity}`));
  assert.equal(result.remainingOwnedIdentities.length, 0);
  result.runtimeDirectories = await runtimeCleanupEvidence(report.cleanup.runtimeDirectories);
  assert.ok(result.runtimeDirectories.every(row => row.exists === false));
  result.completedEndurance = report.endurance.summary;
  result.originalChecksPreserved = { sourceTrees: report.sourcePreservation.length, workers: report.cleanup.workerExits.length,
    restoredNodes: report.restoredOwnedNodes, windowClosure: report.windowClosure };
  assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'), result.originalSha256);
  result.success = true;
} catch (error) { result.failure = error.message; process.exitCode = 1; }
finally { await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ evidence, success: result.success,
  failure: result.failure, measuredOriginalIdentities: result.measuredOriginalIdentities, remainingOwnedIdentities: result.remainingOwnedIdentities, rejectedPidReuse: result.rejectedPidReuse })); }
