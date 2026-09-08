import test from "node:test";
import assert from "node:assert/strict";
import { createAIStatusWatcher } from "../extension/ai-status-watch.mjs";

function status(state, second = state) {
  return {
    names: { state, label: state },
    explanations: { state: second, label: second },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(inspect) {
  let enabled = true,
    visible = true,
    nextTimer = 0;
  const timers = new Map(),
    changes = [];
  const watcher = createAIStatusWatcher({
    inspect,
    onChange: (result) => changes.push(result),
    shouldCheck: () => enabled,
    isVisible: () => visible,
    delayMs: 10,
    setTimer: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    watcher,
    timers,
    changes,
    enabled: (value) => {
      enabled = value;
    },
    visible: (value) => {
      visible = value;
    },
    async tick() {
      const first = timers.entries().next().value;
      if (!first) return;
      timers.delete(first[0]);
      await first[1]();
    },
  };
}

test("external browser download completion changes downloading to ready after passive polling", async () => {
  let calls = 0;
  const f = fixture(async () =>
    status(++calls === 1 ? "downloading" : "ready"),
  );
  await f.watcher.refresh();
  assert.equal(f.changes[0].names.state, "downloading");
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.changes.at(-1).names.state, "ready");
  assert.equal(calls, 2);
  assert.equal(f.timers.size, 0);
});

test("preparation and checking keep polling until both features stop waiting", async () => {
  const states = [
    status("checking"),
    status("ready", "preparing"),
    status("ready"),
  ];
  const f = fixture(async () => states.shift());
  await f.watcher.refresh();
  await f.tick();
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.timers.size, 0);
});

test("hidden interface pauses automatic checks and explicit visible refresh resumes", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return status("downloading");
  });
  await f.watcher.refresh();
  f.visible(false);
  await f.tick();
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
  f.visible(true);
  await f.watcher.refresh();
  assert.equal(calls, 2);
  assert.equal(f.timers.size, 1);
  f.watcher.stop();
});

test("explicit disabled refresh can read labels but cannot begin automatic polling", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return status("downloading");
  });
  f.enabled(false);
  await f.watcher.refresh();
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
});

test("opt-out stops future polls and suppresses an in-flight result", async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  const work = f.watcher.refresh();
  f.enabled(false);
  f.watcher.stop();
  pending.resolve(status("ready"));
  await work;
  assert.equal(f.changes.length, 0);
  assert.equal(f.timers.size, 0);
});

test("concurrent refresh calls share one inspection and do not overlap", async () => {
  let calls = 0;
  const pending = deferred();
  const f = fixture(() => {
    calls++;
    return pending.promise;
  });
  const first = f.watcher.refresh(),
    second = f.watcher.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(status("ready"));
  await first;
  assert.equal(f.changes.length, 1);
});

test("restarting after stop discards the old answer before performing the new check", async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(() =>
    ++calls === 1 ? pending.promise : Promise.resolve(status("ready")),
  );
  const old = f.watcher.refresh();
  await Promise.resolve();
  f.watcher.stop();
  const next = f.watcher.refresh();
  assert.equal(calls, 1);
  pending.resolve(status("downloading"));
  await old;
  await next;
  assert.equal(calls, 2);
  assert.deepEqual(
    f.changes.map((value) => value.names.state),
    ["ready"],
  );
  assert.equal(f.timers.size, 0);
});

test("unchanged waiting status does not repeatedly rerender but continues checking", async () => {
  let calls = 0;
  const f = fixture(async () => status(++calls < 3 ? "downloading" : "ready"));
  await f.watcher.refresh();
  await f.tick();
  assert.equal(f.changes.length, 1);
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.changes.length, 2);
  assert.equal(f.timers.size, 0);
});

test("check failures are safe and do not enter an endless retry loop", async () => {
  const f = fixture(async () => {
    throw new Error("private browser detail");
  });
  await f.watcher.refresh();
  assert.equal(f.changes[0].names.state, "error");
  assert.doesNotMatch(JSON.stringify(f.changes), /private browser detail/);
  assert.equal(f.timers.size, 0);
});

test("download needed or unsupported states do not poll or create a model", async () => {
  for (const state of ["downloadable", "unsupported"]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return status(state);
    });
    await f.watcher.refresh();
    assert.equal(calls, 1);
    assert.equal(f.timers.size, 0);
  }
});

test("malformed results become a safe check failure", async () => {
  const f = fixture(async () => ({ names: { state: "invented" } }));
  await f.watcher.refresh();
  assert.equal(f.changes[0].names.errorCode, "check-failed");
  assert.equal(f.changes[0].names.errorSource, "availability");
  assert.equal(f.changes[0].names.lastRequest, null);
  assert.equal(f.changes[0].names.lastSetup, null);
  assert.equal(f.timers.size, 0);
});
