class Queue {
  constructor(limit = 1) {
    this.limit = limit;
    this.inflight = 0;
    this.q = [];
  }

  enqueue(fn) {
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
}

const queue = new Queue(1);

module.exports = {
  Queue,
  queue
};
