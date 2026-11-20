const worker = new Worker(new URL('./workers/wasmProbeWorker.ts', import.meta.url), { type: 'module' });
worker.onmessage = ({ data }) => {
  document.body.dataset.wasmProbe = data.ok ? 'ok' : 'error';
  document.querySelector('#result')!.textContent = JSON.stringify(data);
  worker.terminate();
};
worker.onerror = (event) => {
  document.body.dataset.wasmProbe = 'error';
  document.querySelector('#result')!.textContent = event.message;
  worker.terminate();
};
worker.postMessage(null);
