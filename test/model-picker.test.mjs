import test from 'node:test';
import assert from 'node:assert/strict';
import { readPickerState } from '../agy-capsule/sidecars/agy_capsule/model_picker.mjs';
import { DEFAULT_SETTINGS } from '../agy-capsule/sidecars/agy_capsule/settings.mjs';

function host(id) {
  const current = { label: 'First (Low)' };
  const target = { label: 'Second (High)' };
  const calls = [];
  const provider = {
    visibleModelConfigs: [current, target, { label: 'Disabled', disabled: true }, target],
    getModelConfigForConversation: () => current,
    setModelConfigByLabelForConversation(...args) { calls.push(args); },
  };
  const root = { memoizedProps: { value: provider } };
  const leaf = { memoizedProps: { conversationId: id, placement: 'top' }, return: root };
  return { leaf, root, provider, calls };
}

test('optional picker sends one exact option to the conversation and reads host state independently', () => {
  assert.equal(DEFAULT_SETTINGS.modelEffortPicker, false);
  const fixture = host('example-a');
  const trigger = { __reactFiber$test: fixture.leaf };
  const state = readPickerState(trigger);
  assert.deepEqual(state.labels, ['First (Low)', 'Second (High)']);
  state.choose('Second (High)');
  assert.deepEqual(fixture.calls, [['Second (High)', 'example-a', false]]);
  assert.equal(readPickerState(trigger).selected, 'First (Low)');
});

test('uses the committed tree after React switches branches', () => {
  const stale = host('example-a'), live = host('example-b');
  stale.leaf.alternate = live.leaf;
  stale.root.stateNode = { current: live.root };
  assert.equal(readPickerState({ __reactFiber$test: stale.leaf }).conversationId, 'example-b');
});

test('missing conversation, selector, or matching selection leaves control to the native picker', () => {
  assert.equal(readPickerState({}), null);
  assert.equal(readPickerState({ __reactFiber$test: host(null).leaf }), null);
  const fixture = host('example');
  fixture.leaf.memoizedProps.modelOptions = [];
  assert.equal(readPickerState({ __reactFiber$test: fixture.leaf }), null);
});
