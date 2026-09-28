// Serializes host reads and retains one trailing refresh so stream events cannot
// overlap workspace/session serialization or lose the latest update.
export function createRefreshQueue(read) {
  let active = null, queued = null;
  function start() {
    const task = Promise.resolve().then(read);
    active = task;
    const settle = () => {
      if (queued) {
        const next = queued;
        queued = null;
        start().then(next.resolve, next.reject);
      } else active = null;
    };
    task.then(settle, settle);
    return task;
  }
  return function refresh() {
    if (!active) return start();
    if (!queued) {
      let resolve, reject;
      const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
      queued = { promise, resolve, reject };
    }
    return queued.promise;
  };
}
