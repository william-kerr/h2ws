type Job = (done: () => void) => void

/**
 * Very simple job queue with adjustable concurrency, adapted from:
 * https://github.com/STRML/async-limiter
 */
export class Limiter {
  private jobs: Job[]
  private pending: number
  private doneCallback: () => void

  /**
   * Create new Limiter
   *
   * @param concurrency - Max number of jobs allowed to run concurrently
   */
  constructor(private concurrency: number = Infinity) {
    this.concurrency = concurrency || Infinity
    this.jobs = []
    this.pending = 0

    this.doneCallback = () => {
      this.pending--
      this.run()
    }
  }

  /**
   * Add job to queue
   *
   * @param job - Job to run
   */
  add(job: Job): void {
    this.jobs.push(job)
    this.run()
  }

  /**
   * Remove job from queue and run it if possible
   */
  private run(): void {
    if (this.pending === this.concurrency) return

    if (this.jobs.length) {
      const job = this.jobs.shift()!

      this.pending++
      job(this.doneCallback)
    }
  }
}
