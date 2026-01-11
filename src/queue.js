class Queue {
  constructor(limit = 1, options = {}) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.inflight = 0;
    this.q = [];
    this.options = {
      maxQueueLength: options.maxQueueLength || Infinity,
      ...options
    };
  }

  get size() {
    return this.q.length;
  }

  get inflightCount() {
    return this.inflight;
  }

  get isEmpty() {
    return this.q.length === 0 && this.inflight === 0;
  }

  enqueue(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('enqueue requires a function');
    }

    if (this.q.length >= this.options.maxQueueLength) {
      return Promise.reject(new Error('Queue is full'));
    }

    return new Promise((resolve, reject) => {
      this.q.push({ fn, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.inflight >= this.limit) return;
    const job = this.q.shift();
    if (!job) return;
    
    this.inflight++;
    Promise.resolve()
      .then(() => job.fn())
      .then(job.resolve, job.reject)
      .finally(() => {
        this.inflight--;
        this._pump();
      });
  }

  clear() {
    this.q.length = 0;
  }
}

const queue = new Queue(1);

export { Queue, queue };
