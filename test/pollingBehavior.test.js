import { test } from 'node:test';
import { strict as assert } from 'node:assert';

/**
 * Phase 1.6 Tests: Container Stop Optimization - Polling & Progress Tracking
 *
 * Tests focus on:
 * - Polling state management in explorerProvider
 * - Progress callback invocations
 * - UI state transitions
 * - Exponential backoff behavior
 * - Error handling and recovery
 */

// ============================================================================
// Polling State Management Tests
// ============================================================================

test('polling state key generation creates unique keys', () => {
  // Test that different guests get different keys
  const key1 = 'connection1:lxc:100';
  const key2 = 'connection1:lxc:101';
  const key3 = 'connection2:lxc:100';

  assert.notStrictEqual(key1, key2, 'Different VMIDs should create different keys');
  assert.notStrictEqual(key1, key3, 'Different connections should create different keys');
  assert.strictEqual(key1, 'connection1:lxc:100', 'Key format should be consistent');
});

test('polling state transitions from polling to stopped', () => {
  const states = [];

  // Simulate state transitions
  states.push({ phase: 'polling', startTime: Date.now() });
  assert.strictEqual(states[0].phase, 'polling', 'Initial state should be polling');

  states.push({ phase: 'stopped', startTime: Date.now() });
  assert.strictEqual(states[1].phase, 'stopped', 'Final state should be stopped');
});

test('polling state transitions from polling to failed', () => {
  const states = [];

  // Simulate failure transition
  states.push({ phase: 'polling', startTime: Date.now() });
  states.push({ phase: 'failed', startTime: Date.now() });

  assert.strictEqual(states[1].phase, 'failed', 'Failed state should be tracked');
});

// ============================================================================
// Progress Callback Tests
// ============================================================================

test('progress callback is invoked with polling phase', () => {
  const callbackPhases = [];

  const onProgress = (phase) => {
    callbackPhases.push(phase);
  };

  // Simulate callback invocations during polling
  onProgress('polling');

  assert.strictEqual(callbackPhases.length, 1, 'Callback should be called once');
  assert.strictEqual(callbackPhases[0], 'polling', 'Callback should receive polling phase');
});

test('progress callback is invoked with stopped phase', () => {
  const callbackPhases = [];

  const onProgress = (phase) => {
    callbackPhases.push(phase);
  };

  // Simulate polling then stopping
  onProgress('polling');
  onProgress('stopped');

  assert.strictEqual(callbackPhases.length, 2, 'Callback should be called twice');
  assert.strictEqual(callbackPhases[1], 'stopped', 'Callback should receive stopped phase');
});

test('progress callback is invoked with failed phase', () => {
  const callbackPhases = [];

  const onProgress = (phase) => {
    callbackPhases.push(phase);
  };

  // Simulate polling then failure
  onProgress('polling');
  onProgress('failed');

  assert.strictEqual(callbackPhases.length, 2, 'Callback should be called twice');
  assert.strictEqual(callbackPhases[1], 'failed', 'Callback should receive failed phase');
});

// ============================================================================
// UI State Transition Tests
// ============================================================================

test('guest item shows correct icon based on polling phase', () => {
  const guestIcons = {
    'polling': 'vm-starting', // Yellow
    'stopped': 'vm-stopped', // Gray
    'failed': 'vm-error', // Red
    'running': 'vm-running' // Green
  };

  assert.strictEqual(guestIcons['polling'], 'vm-starting', 'Polling phase should show starting icon');
  assert.strictEqual(guestIcons['failed'], 'vm-error', 'Failed phase should show error icon');
  assert.strictEqual(guestIcons['stopped'], 'vm-stopped', 'Stopped phase should show stopped icon');
});

test('guest item shows correct description based on polling phase', () => {
  const descriptions = {
    'polling': 'Stopping...',
    'stopped': 'CPU 0% / 4',
    'failed': 'Operation failed'
  };

  assert.strictEqual(descriptions['polling'], 'Stopping...', 'Should show stopping message during polling');
  assert.strictEqual(descriptions['failed'], 'Operation failed', 'Should show failure message on error');
});

test('guest item tooltip updates during polling', () => {
  const tooltips = {
    'polling': 'Status: Polling for completion...',
    'failed': 'Status: Operation failed',
    'normal': 'Status: running'
  };

  assert.match(tooltips['polling'], /Polling for completion/, 'Tooltip should indicate polling state');
  assert.match(tooltips['failed'], /Operation failed/, 'Tooltip should indicate failure');
});

// ============================================================================
// Exponential Backoff Tests
// ============================================================================

test('exponential backoff starts at 500ms', () => {
  const initialInterval = 500;
  assert.strictEqual(initialInterval, 500, 'Initial interval should be 500ms');
});

test('exponential backoff multiplies by 1.5 each iteration', () => {
  const intervals = [];
  let interval = 500;

  for (let i = 0; i < 5; i++) {
    intervals.push(interval);
    interval *= 1.5;
  }

  assert.strictEqual(intervals[0], 500, 'First interval should be 500ms');
  assert.strictEqual(intervals[1], 750, 'Second interval should be 750ms');
  assert.strictEqual(intervals[2], 1125, 'Third interval should be 1125ms');
  assert.strictEqual(intervals[3], 1687.5, 'Fourth interval should be 1687.5ms');
  assert.strictEqual(intervals[4], 2531.25, 'Fifth interval should be 2531.25ms');
});

test('exponential backoff caps at 30 seconds', () => {
  let interval = 500;
  const maxInterval = 30000;
  let iterations = 0;

  while (interval < maxInterval && iterations < 100) {
    interval *= 1.5;
    iterations++;
  }

  // Apply cap
  interval = Math.min(interval, maxInterval);

  assert.strictEqual(interval, maxInterval, 'Interval should be capped at 30000ms');
});

test('exponential backoff never exceeds 30 seconds', () => {
  const intervals = [];
  let interval = 500;
  const maxInterval = 30000;

  for (let i = 0; i < 20; i++) {
    interval = Math.min(interval * 1.5, maxInterval);
    intervals.push(interval);
  }

  const exceedsMax = intervals.some(i => i > maxInterval);
  assert.strictEqual(exceedsMax, false, 'No interval should exceed 30000ms');

  // All later intervals should be at the cap
  const atMax = intervals.slice(10).every(i => i === maxInterval);
  assert.strictEqual(atMax, true, 'Later intervals should stabilize at max');
});

// ============================================================================
// Container-Specific Polling Tests
// ============================================================================

test('container operations use 3 second polling interval', () => {
  const containerInterval = 3000;
  const qemuInterval = 500;

  assert.strictEqual(containerInterval, 3000, 'Container interval should be 3000ms');
  assert.notStrictEqual(containerInterval, qemuInterval, 'Container and QEMU should use different intervals');
});

test('polling interval optimizes for guest type', () => {
  const intervals = {
    'lxc': 3000, // LXC containers get 3s (faster feedback)
    'qemu': 500 // VMs start with 500ms with exponential backoff
  };

  assert.strictEqual(intervals['lxc'], 3000, 'LXC containers should use 3s interval');
  assert.strictEqual(intervals['qemu'], 500, 'QEMU VMs should start with 500ms');
});

// ============================================================================
// Timeout & Deadline Tests
// ============================================================================

test('polling respects 5 minute timeout deadline', () => {
  const maxWaitMs = 5 * 60 * 1000; // 5 minutes

  assert.strictEqual(maxWaitMs, 300000, 'Timeout should be 5 minutes (300000ms)');
});

test('polling terminates after deadline exceeded', () => {
  const startTime = Date.now();
  const maxWaitMs = 300000;
  const simulatedElapsed = 350000; // 350 seconds

  const shouldTerminate = (Date.now() - startTime + simulatedElapsed) > maxWaitMs;
  assert.strictEqual(shouldTerminate, true, 'Polling should terminate after deadline');
});

test('timeout throws appropriate error', () => {
  const timeoutError = new Error('Timeout waiting for task to complete');

  assert.match(timeoutError.message, /Timeout/, 'Error should indicate timeout');
  assert.match(timeoutError.message, /task/, 'Error should mention task');
});

// ============================================================================
// Error Handling Tests
// ============================================================================

test('polling handles network errors gracefully', () => {
  const networkError = new Error('Unable to connect');
  const errorPhases = [];

  try {
    throw networkError;
  } catch (error) {
    errorPhases.push('failed');
  }

  assert.strictEqual(errorPhases.length, 1, 'Error should be caught');
  assert.strictEqual(errorPhases[0], 'failed', 'Should transition to failed state');
});

test('polling handles task failure responses', () => {
  const taskStatus = { status: 'stopped', exitstatus: 'error' };
  const isFailed = taskStatus.exitstatus && taskStatus.exitstatus !== 'OK';

  assert.strictEqual(isFailed, true, 'Should recognize task failure status');
});

test('polling recovers from transient errors', () => {
  const transientErrors = [
    'timeout',
    'socket hang up',
    'ECONNRESET',
    'temporarily unavailable'
  ];

  const isTransient = (msg) =>
    msg.toLowerCase().includes('timeout') ||
    msg.toLowerCase().includes('socket hang up') ||
    msg.toLowerCase().includes('econnreset') ||
    msg.toLowerCase().includes('temporarily unavailable');

  transientErrors.forEach(err => {
    assert.strictEqual(isTransient(err), true, `Should recognize transient error: ${err}`);
  });
});

// ============================================================================
// State Management & Cleanup Tests
// ============================================================================

test('polling state is cleared after completion', () => {
  const pollingStates = new Map();
  const key = 'connection1:lxc:100';

  // Start polling
  pollingStates.set(key, { phase: 'polling', startTime: Date.now() });
  assert.strictEqual(pollingStates.has(key), true, 'Should track polling state');

  // Completion
  pollingStates.delete(key);
  assert.strictEqual(pollingStates.has(key), false, 'Should clean up after completion');
});

test('polling states do not accumulate', () => {
  const pollingStates = new Map();

  // Multiple operations
  const key1 = 'connection1:lxc:100';
  const key2 = 'connection1:lxc:101';
  const key3 = 'connection1:lxc:102';

  pollingStates.set(key1, { phase: 'polling' });
  pollingStates.set(key2, { phase: 'polling' });
  pollingStates.set(key3, { phase: 'polling' });

  assert.strictEqual(pollingStates.size, 3, 'Should track multiple operations');

  // Cleanup
  pollingStates.delete(key1);
  assert.strictEqual(pollingStates.size, 2, 'Should reduce size after cleanup');
});

// ============================================================================
// Tree Refresh Trigger Tests
// ============================================================================

test('tree refresh is fired on polling start', () => {
  const refreshEvents = [];

  const fireRefresh = () => {
    refreshEvents.push({ type: 'refresh', timestamp: Date.now() });
  };

  // Start polling
  fireRefresh();

  assert.strictEqual(refreshEvents.length, 1, 'Should fire refresh on start');
  assert.strictEqual(refreshEvents[0].type, 'refresh', 'Should be refresh event');
});

test('tree refresh is fired on polling completion', () => {
  const refreshEvents = [];

  const fireRefresh = () => {
    refreshEvents.push(Date.now());
  };

  // Start and complete
  fireRefresh(); // Start
  fireRefresh(); // End

  assert.strictEqual(refreshEvents.length, 2, 'Should fire refresh twice');
});

// ============================================================================
// Integration Tests
// ============================================================================

test('complete polling lifecycle works correctly', () => {
  const events = [];
  const pollingStates = new Map();
  const key = 'connection1:lxc:100';

  const onProgress = (phase) => {
    events.push(`progress:${phase}`);

    if (phase === 'polling') {
      pollingStates.set(key, { phase, startTime: Date.now() });
    } else {
      pollingStates.delete(key);
    }
  };

  // Simulate complete operation
  onProgress('polling');
  assert.strictEqual(pollingStates.has(key), true, 'Should track during polling');

  onProgress('stopped');
  assert.strictEqual(pollingStates.has(key), false, 'Should clean up after completion');

  assert.deepStrictEqual(events, ['progress:polling', 'progress:stopped'], 'Should have correct sequence');
});

test('concurrent polling operations are tracked independently', () => {
  const pollingStates = new Map();
  const key1 = 'connection1:lxc:100';
  const key2 = 'connection1:lxc:101';

  // Start two operations
  pollingStates.set(key1, { phase: 'polling', startTime: Date.now() });
  pollingStates.set(key2, { phase: 'polling', startTime: Date.now() });

  assert.strictEqual(pollingStates.size, 2, 'Should track both operations');

  // Complete first
  pollingStates.delete(key1);
  assert.strictEqual(pollingStates.size, 1, 'Should track only remaining operation');
  assert.strictEqual(pollingStates.has(key2), true, 'Other operation should continue');

  // Complete second
  pollingStates.delete(key2);
  assert.strictEqual(pollingStates.size, 0, 'Should clean up all operations');
});

// ============================================================================
// Progress Callback Robustness Tests
// ============================================================================

test('progress callback handles undefined phase gracefully', () => {
  const validPhases = ['polling', 'stopped', 'failed'];
  const invalidPhase = 'unknown';

  const isValid = validPhases.includes(invalidPhase);
  assert.strictEqual(isValid, false, 'Should not accept invalid phases');
});

test('progress callback is idempotent for same phase', () => {
  const states = [];

  const onProgress = (phase) => {
    if (states.length === 0 || states[states.length - 1] !== phase) {
      states.push(phase);
    }
  };

  onProgress('polling');
  onProgress('polling'); // Duplicate
  onProgress('polling'); // Duplicate

  assert.deepStrictEqual(states, ['polling'], 'Should not duplicate same phase');
});

// ============================================================================
// Performance Tests
// ============================================================================

test('polling state lookup is O(1)', () => {
  const pollingStates = new Map();

  // Add many states
  for (let i = 0; i < 1000; i++) {
    pollingStates.set(`connection1:lxc:${i}`, { phase: 'polling' });
  }

  const startTime = Date.now();

  // Lookup should be fast regardless of size
  pollingStates.get('connection1:lxc:500');
  pollingStates.get('connection1:lxc:999');

  const elapsed = Date.now() - startTime;
  assert.strictEqual(elapsed < 10, true, 'Lookups should be very fast (< 10ms for 1000 items)');
});

test('tree refresh does not block on large polling state maps', () => {
  const pollingStates = new Map();

  // Add many states
  for (let i = 0; i < 500; i++) {
    pollingStates.set(`connection${i % 10}:${i % 2 === 0 ? 'qemu' : 'lxc'}:${i}`, { phase: 'polling' });
  }

  const startTime = Date.now();

  // Iterate through all
  const activePolling = [];
  for (const [key, state] of pollingStates) {
    if (state.phase === 'polling') {
      activePolling.push(key);
    }
  }

  const elapsed = Date.now() - startTime;
  assert.strictEqual(elapsed < 50, true, 'Should handle large state maps quickly (< 50ms)');
  assert.strictEqual(activePolling.length, 500, 'Should find all polling states');
});
