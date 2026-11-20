import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  readCloudTrajectory,
  readCloudConversationSnapshot,
  createCloudTelemetryStore,
} from '../agy-capsule/sidecars/agy_capsule/cloud_telemetry.mjs';
import { buildRuntimeBundle } from '../agy-capsule/sidecars/agy_capsule/deck_injector.mjs';

test('readCloudTrajectory extracts matching trajectorySlice from React fiber and ignores other conversations', () => {
  const convId = 'fdeb3371-3973-474c-9765-b789e9a2aa18';
  const rootEl = {
    __reactContainer$abc: {
      child: {
        memoizedProps: {
          trajectorySlice: {
            conversationId: 'other-conv-id',
            stepsInSlice: [{ type: 14, status: 3, metadata: {} }],
          },
        },
        sibling: {
          memoizedProps: {
            trajectorySlice: {
              conversationId: convId,
              totalStepsLength: 2,
              lastStepError: '',
              stepsInSlice: [
                {
                  type: 14,
                  status: 3,
                  metadata: {
                    executionId: 'exec-1',
                    createdAt: { seconds: '1795177897', nanos: 283102310 },
                    sourceTrajectoryStepInfo: { stepIndex: 0 },
                  },
                },
                {
                  type: 15,
                  status: 3,
                  metadata: {
                    executionId: 'exec-1',
                    createdAt: { seconds: '1795177915', nanos: 710358978 },
                    viewableAt: { seconds: '1795177918', nanos: 991327900 },
                    finishedGeneratingAt: { seconds: '1795177919', nanos: 145412754 },
                    completedAt: { seconds: '1795177919', nanos: 145412754 },
                    modelUsage: {
                      inputTokens: '16822',
                      outputTokens: '57',
                      thinkingOutputTokens: '54',
                      responseOutputTokens: '3',
                      cacheReadTokens: '0',
                    },
                    modelInfo: { maxTokens: 1048576 },
                    sourceTrajectoryStepInfo: { stepIndex: 1 },
                  },
                },
              ],
              executorMetadatasInSlice: [],
            },
          },
        },
      },
    },
  };

  const sandbox = {
    document: { getElementById: id => (id === 'root' ? rootEl : null), body: null },
  };
  const fn = vm.runInNewContext(`(${readCloudTrajectory.toString()})`, sandbox);

  assert.equal(fn('non-existent-id'), null);
  const extracted = fn(convId);
  assert.ok(extracted);
  assert.equal(extracted.conversationId, convId);
  assert.equal(extracted.steps.length, 2);
  assert.equal(extracted.steps[1].inputTokens, 16822);
  assert.equal(extracted.steps[1].thinkingTokens, 54);
  assert.equal(extracted.steps[1].replyTokens, 3);
  assert.equal(extracted.steps[1].maxContextTokens, 1048576);
});

test('readCloudConversationSnapshot computes context, cache, speed, turn metrics, and compaction breakdown', () => {
  const snapshot = readCloudConversationSnapshot({
    conversationId: 'cloud-1',
    steps: [
      {
        idx: 0, stepType: 14, status: 3,
        createdAtMs: 1_700_000_000_000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 0,
        executionId: 'e1', hasUsage: false, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
        thinkingTokens: 0, replyTokens: 0, maxContextTokens: 0, retryErrors: [],
      },
      {
        idx: 1, stepType: 15, status: 3,
        createdAtMs: 1_700_000_001_000, viewableAtMs: 1_700_000_003_000,
        finishedGeneratingAtMs: 1_700_000_004_000, completedAtMs: 1_700_000_004_000,
        executionId: 'e1', hasUsage: true, inputTokens: 16822, cacheReadTokens: 0, outputTokens: 60,
        thinkingTokens: 50, replyTokens: 10, maxContextTokens: 1048576, retryErrors: [],
      },
      {
        idx: 2, stepType: 14, status: 3,
        createdAtMs: 1_700_000_010_000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 0,
        executionId: 'e2', hasUsage: false, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
        thinkingTokens: 0, replyTokens: 0, maxContextTokens: 0, retryErrors: [],
      },
      {
        idx: 3, stepType: 15, status: 3,
        createdAtMs: 1_700_000_011_000, viewableAtMs: 1_700_000_012_000,
        finishedGeneratingAtMs: 1_700_000_014_000, completedAtMs: 1_700_000_014_000,
        executionId: 'e2', hasUsage: true, inputTokens: 2000, cacheReadTokens: 16000, outputTokens: 90,
        thinkingTokens: 60, replyTokens: 30, maxContextTokens: 1048576, retryErrors: [],
      },
    ],
    executors: [],
    lastStepError: '',
  }, true);

  assert.equal(snapshot.contextTokens, 18000);
  assert.equal(snapshot.cachedIn, 16000);
  assert.equal(snapshot.uncachedIn, 2000);
  assert.equal(snapshot.maxContextTokens, 1048576);
  assert.equal(snapshot.turn0Tokens, 16822);
  assert.equal(snapshot.totalThinkingTokens, 50);
  assert.equal(snapshot.totalOutputTokens, 10);
  assert.equal(snapshot.generation.ttft, 1);
  assert.equal(snapshot.generation.streaming, 2);
  assert.equal(snapshot.generation.tps, 30);
  assert.equal(snapshot.turnSpeed.generation.tps, 30);
  assert.equal(snapshot.turnMetrics.state, 'completed');
  assert.equal(snapshot.turnMetrics.duration, 4);
  assert.equal(snapshot.requestError.kind, 'none');
});

test('readCloudConversationSnapshot classifies retry errors and lastStepError and respects compaction checkpoints', () => {
  const snapshot = readCloudConversationSnapshot({
    conversationId: 'cloud-2',
    steps: [
      {
        idx: 0, stepType: 14, status: 3, createdAtMs: 1000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 0,
        executionId: 'e1', hasUsage: false, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, replyTokens: 0, maxContextTokens: 0, retryErrors: [],
      },
      {
        idx: 1, stepType: 15, status: 3, createdAtMs: 2000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 3000,
        executionId: 'e1', hasUsage: true, inputTokens: 50000, cacheReadTokens: 0, outputTokens: 2000, thinkingTokens: 1500, replyTokens: 500, maxContextTokens: 200000, retryErrors: [],
      },
      {
        idx: 2, stepType: 23, status: 3, createdAtMs: 4000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 4000,
        executionId: 'e1', hasUsage: false, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, replyTokens: 0, maxContextTokens: 0, retryErrors: [],
      },
      {
        idx: 3, stepType: 14, status: 3, createdAtMs: 5000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 0,
        executionId: 'e2', hasUsage: false, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, replyTokens: 0, maxContextTokens: 0, retryErrors: [],
      },
      {
        idx: 4, stepType: 15, status: 7, createdAtMs: 6000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 7000,
        executionId: 'e2', hasUsage: true, inputTokens: 10000, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, replyTokens: 0, maxContextTokens: 200000,
        retryErrors: ['HTTP 429 rate limit exceeded, retry in 15s'],
      },
    ],
    executors: [],
    lastStepError: '',
  }, false);

  assert.equal(snapshot.contextTokens, 10000);
  assert.equal(snapshot.turn0Tokens, 10000);
  assert.equal(snapshot.totalOutputTokens, 0);
  assert.equal(snapshot.totalThinkingTokens, 0);
  assert.equal(snapshot.requestError.kind, 'rate_limited');
  assert.equal(snapshot.requestError.retryAfterSec, 15);
  assert.equal(snapshot.turnMetrics, null);
});

test('createCloudTelemetryStore evicts oldest entries and buildRuntimeBundle embeds readCloudTrajectory cleanly', () => {
  const store = createCloudTelemetryStore(2);
  const mk = tokens => ({
    steps: [{
      idx: 0, stepType: 15, status: 3, createdAtMs: 1000, viewableAtMs: 0, finishedGeneratingAtMs: 0, completedAtMs: 2000,
      executionId: '', hasUsage: true, inputTokens: tokens, cacheReadTokens: 0, outputTokens: 10, thinkingTokens: 5, replyTokens: 5, maxContextTokens: 100000, retryErrors: [],
    }],
  });
  store.set('c1', mk(100));
  store.set('c2', mk(200));
  store.set('c3', mk(300));
  assert.equal(store.has('c1'), false);
  assert.equal(store.read('c2').contextTokens, 200);
  assert.equal(store.read('c3').contextTokens, 300);

  const { code } = buildRuntimeBundle(12345);
  assert.match(code, /function readCloudTrajectory\(/);
  new vm.Script(code);
});
