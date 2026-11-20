import { summarizeGeneration, summarizeTurnSpeed, summarizeTurnQueue } from './metrics.mjs';
import { summarizeTurnMetrics } from './turn_metrics.mjs';
import { classifyRequestError } from './errors.mjs';

// Runs inside the Antigravity renderer via buildRuntimeBundle().
// Must remain self-contained (no module imports or outer closures).
export function readCloudTrajectory(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') return null;
  const rootEl = document.getElementById('root') || document.body?.firstElementChild;
  if (!rootEl) return null;
  const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
  if (!fiberKey) return null;

  const toNum = value => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const tsMs = ts => {
    if (!ts || typeof ts !== 'object') return 0;
    if (ts.seconds === undefined && ts.nanos === undefined) return 0;
    const sec = Number(ts.seconds || 0);
    const nano = Number(ts.nanos || 0);
    if (!Number.isFinite(sec) || !Number.isFinite(nano)) return 0;
    const ms = sec * 1000 + nano / 1e6;
    return ms > 0 ? ms : 0;
  };
  const errText = value => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      if (typeof value.message === 'string' && value.message) return value.message;
      if (typeof value.error === 'string' && value.error) return value.error;
      if (typeof value.userErrorMessage === 'string' && value.userErrorMessage) return value.userErrorMessage;
    }
    return '';
  };

  const seen = new WeakSet();
  const queue = [rootEl[fiberKey]];
  let visited = 0;
  let slice = null;
  while (queue.length && visited < 6000) {
    const fiber = queue.shift();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    visited++;
    const ts = fiber.memoizedProps?.trajectorySlice;
    if (ts && Array.isArray(ts.stepsInSlice)) {
      if (!ts.conversationId || ts.conversationId === conversationId) {
        slice = ts;
        break;
      }
    }
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  if (!slice || slice.stepsInSlice.length === 0) return null;

  const stepsOffset = toNum(slice.stepsSlice?.startIndex);
  const steps = slice.stepsInSlice.map((step, i) => {
    const m = step?.metadata || {};
    const u = m.modelUsage || null;
    const stepIndex = m.sourceTrajectoryStepInfo?.stepIndex;
    const idx = Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : stepsOffset + i;
    const retryErrors = Array.isArray(m.retryInfos)
      ? m.retryInfos.map(r => errText(r?.error ?? r)).filter(Boolean)
      : [];
    return {
      idx,
      stepType: toNum(step?.type),
      status: toNum(step?.status),
      createdAtMs: tsMs(m.createdAt),
      viewableAtMs: tsMs(m.viewableAt),
      finishedGeneratingAtMs: tsMs(m.finishedGeneratingAt),
      completedAtMs: tsMs(m.completedAt),
      executionId: typeof m.executionId === 'string' ? m.executionId : '',
      hasUsage: Boolean(u),
      inputTokens: u ? toNum(u.inputTokens) : 0,
      cacheReadTokens: u ? toNum(u.cacheReadTokens) : 0,
      outputTokens: u ? toNum(u.outputTokens) : 0,
      thinkingTokens: u ? toNum(u.thinkingOutputTokens) : 0,
      replyTokens: u ? toNum(u.responseOutputTokens) : 0,
      maxContextTokens: toNum(m.modelInfo?.maxTokens),
      retryErrors,
    };
  });

  const executors = Array.isArray(slice.executorMetadatasInSlice)
    ? slice.executorMetadatasInSlice.map(ex => ({
        reason: toNum(ex?.terminationReason ?? ex?.reason),
        lastStepIndex: Number.isInteger(ex?.lastStepIndex) ? ex.lastStepIndex : -1,
        executionId: typeof ex?.executionId === 'string' ? ex.executionId : '',
      }))
    : [];

  return {
    conversationId: slice.conversationId || conversationId,
    totalStepsLength: toNum(slice.totalStepsLength) || steps.length,
    lastStepError: errText(slice.lastStepError),
    steps,
    executors,
  };
}

const ACTIVE_STATUSES = new Set([1, 2, 8, 9, 11]);

export function readCloudConversationSnapshot(raw, includeTurnMetrics = true) {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) return null;
  const steps = [...raw.steps].sort((a, b) => a.idx - b.idx);

  let userStepIndex = null;
  let metricsUserStepIndex = null;
  const cpIndices = [];
  for (const step of steps) {
    if (step.stepType === 23) cpIndices.push(step.idx);
    if (step.stepType === 14) {
      metricsUserStepIndex = step.idx;
      if (step.status !== 11) userStepIndex = step.idx;
    }
  }
  cpIndices.sort((a, b) => b - a);
  if (!includeTurnMetrics) metricsUserStepIndex = null;

  const lastStep = steps.at(-1);
  let lastStepEpochMs = lastStep?.createdAtMs || lastStep?.completedAtMs || lastStep?.finishedGeneratingAtMs || 0;

  const firstTurnStep = userStepIndex ?? metricsUserStepIndex;
  const turnSteps = firstTurnStep === null ? [] : steps
    .filter(step => step.idx >= firstTurnStep)
    .map(step => {
      const completed = step.finishedGeneratingAtMs || step.completedAtMs || 0;
      const recordedCompleted = step.completedAtMs || step.finishedGeneratingAtMs || null;
      return {
        idx: step.idx,
        step_type: step.stepType,
        status: step.status,
        completedAtMs: completed,
        recordedCompletedAtMs: recordedCompleted,
        createdAtMs: step.createdAtMs || null,
        inputStartedAtMs: step.stepType === 14 && step.status !== 11 ? (step.createdAtMs || null) : null,
        generatingAtMs: step.viewableAtMs || null,
        terminalAtMs: [3, 6, 7, 12].includes(step.status) ? recordedCompleted : null,
        executionId: step.executionId || '',
      };
    });

  let executors = Array.isArray(raw.executors) ? raw.executors : [];
  if (executors.length === 0 && firstTurnStep !== null && turnSteps.length > 0) {
    const active = turnSteps.some(step => step.step_type !== 14 && ACTIVE_STATUSES.has(step.status));
    const tail = turnSteps.at(-1);
    if (!active && tail && tail.step_type === 15 && tail.status === 3 && (tail.recordedCompletedAtMs || tail.completedAtMs)) {
      executors = [{ reason: 4, lastStepIndex: tail.idx, executionId: tail.executionId }];
    }
  }

  const turns = [];
  const parsedRequests = [];
  let maxContextTokens = 0;
  let latestGeneration = null;
  let latestRequestError = classifyRequestError();

  let reqIdx = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const hasRetryErr = Array.isArray(step.retryErrors) && step.retryErrors.length > 0;
    const uncachedIn = step.inputTokens || 0;
    const cachedIn = step.cacheReadTokens || 0;
    const contextTokens = uncachedIn + cachedIn;
    const thinkTokens = step.thinkingTokens || 0;
    const outTokens = step.replyTokens || 0;
    const totalOut = step.outputTokens || (thinkTokens + outTokens);
    const hasOutput = step.hasUsage && (totalOut > 0 || (step.status === 3 && contextTokens > 0));
    if (step.maxContextTokens > 0) maxContextTokens = step.maxContextTokens;
    if (!step.hasUsage && !hasRetryErr) continue;

    let ttft = null;
    let streaming = null;
    if (step.createdAtMs > 0 && step.viewableAtMs >= step.createdAtMs && step.finishedGeneratingAtMs >= step.viewableAtMs && step.finishedGeneratingAtMs > step.createdAtMs) {
      ttft = (step.viewableAtMs - step.createdAtMs) / 1000;
      streaming = (step.finishedGeneratingAtMs - step.viewableAtMs) / 1000;
    }

    const lastRetryErr = hasRetryErr ? step.retryErrors.at(-1) : '';
    const requestError = classifyRequestError(lastRetryErr);
    const prevIdx = i > 0 ? steps[i - 1].idx : Math.max(0, step.idx - 1);
    const splitMatches = totalOut === thinkTokens + outTokens;
    const usageRecord = {
      read: step.hasUsage ? contextTokens : null,
      cachedRead: step.hasUsage ? cachedIn : null,
      uncachedRead: step.hasUsage ? uncachedIn : null,
      write: step.hasUsage && splitMatches ? outTokens : null,
      thinking: step.hasUsage && splitMatches ? thinkTokens : null,
    };
    const generation = {
      requestIndex: reqIdx,
      ttft,
      streaming,
      output: hasOutput ? totalOut : null,
      reply: hasOutput ? outTokens : null,
      thinking: hasOutput ? thinkTokens : null,
    };
    const parsed = {
      turn: reqIdx,
      uncachedIn,
      cachedIn,
      contextTokens,
      outTokens,
      thinkTokens,
      maxContextTokens: step.maxContextTokens || 0,
      lastStepIndex: prevIdx,
      stepIndices: [step.idx],
      requestError,
      attempts: [{ usage: usageRecord }],
      missingAttempts: 0,
      pendingAttempt: false,
      generation,
    };
    reqIdx++;
    parsedRequests.push(parsed);
    latestGeneration = generation;
    const earlierRequest = userStepIndex !== null && parsed.lastStepIndex >= 0 && parsed.lastStepIndex < userStepIndex;
    if (!earlierRequest) latestRequestError = requestError;
    if (contextTokens > 0) turns.push(parsed);
  }

  if (latestRequestError.kind === 'none' && raw.lastStepError) {
    latestRequestError = classifyRequestError(raw.lastStepError);
  }

  let epochStart = 0;
  if (turns.length > 0) {
    for (const cpIdx of cpIndices) {
      const postIdx = turns.findIndex(t => t.lastStepIndex >= cpIdx);
      if (postIdx >= 0) {
        epochStart = postIdx;
        break;
      }
    }
    for (let i = epochStart + 1; i < turns.length; i++) {
      if (turns[i].contextTokens < turns[i - 1].contextTokens * 0.7) {
        epochStart = i;
      }
    }
  }

  const latest = turns.at(-1) || {
    uncachedIn: 0,
    cachedIn: 0,
    contextTokens: 0,
    outTokens: 0,
    thinkTokens: 0,
  };
  if (turns.length === 0 || latest.contextTokens === 0) {
    lastStepEpochMs = 0;
  }

  let rawOut = 0;
  let rawThink = 0;
  for (let i = epochStart; i < turns.length - 1; i++) {
    rawOut += turns[i].outTokens;
    rawThink += turns[i].thinkTokens;
  }

  const turn0Tokens = Math.min(turns[epochStart]?.contextTokens || 0, latest.contextTokens);
  const availGen = Math.max(0, latest.contextTokens - turn0Tokens);
  const genSum = rawOut + rawThink;
  const genScale = genSum > availGen && genSum > 0 ? availGen / genSum : 1;
  const totalOutputTokens = Math.round(rawOut * genScale);
  const totalThinkingTokens = Math.round(rawThink * genScale);

  return {
    turnSpeed: summarizeTurnSpeed(parsedRequests, turnSteps, userStepIndex),
    turnQueue: summarizeTurnQueue(parsedRequests, turnSteps, userStepIndex, executors),
    turnMetrics: includeTurnMetrics
      ? summarizeTurnMetrics(parsedRequests, turnSteps.map(step => ({ ...step, completedAtMs: step.recordedCompletedAtMs })), metricsUserStepIndex, executors)
      : null,
    requestError: latestRequestError,
    generation: summarizeGeneration(latestGeneration),
    cachedIn: latest.cachedIn,
    uncachedIn: latest.uncachedIn,
    contextTokens: latest.contextTokens,
    maxContextTokens,
    lastStepEpochMs,
    turn0Tokens,
    totalOutputTokens,
    totalThinkingTokens,
  };
}

export function createCloudTelemetryStore(maxEntries = 8) {
  const entries = new Map();
  return {
    set(convId, raw) {
      if (!convId || typeof convId !== 'string' || !raw || !Array.isArray(raw.steps) || raw.steps.length === 0) return;
      entries.delete(convId);
      entries.set(convId, raw);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    read(convId, includeTurnMetrics = true) {
      const raw = convId ? entries.get(convId) : null;
      return raw ? readCloudConversationSnapshot(raw, includeTurnMetrics) : null;
    },
    has(convId) {
      return Boolean(convId && entries.has(convId));
    },
  };
}
