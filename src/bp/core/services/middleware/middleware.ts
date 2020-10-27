import * as sdk from 'botpress/sdk'
import _ from 'lodash'
import ms from 'ms'

import { addStepToEvent } from './event-collector'

interface MiddlewareChainOptions {
  timeoutInMs: number
}

const defaultOptions = {
  timeoutInMs: ms('2s')
}

export class MiddlewareChain {
  private stack: { mw: sdk.IO.MiddlewareHandler; name: string }[] = []

  constructor(private options: MiddlewareChainOptions = defaultOptions) {
    this.options = { ...defaultOptions, ...options }
  }

  use({ handler, name }: sdk.IO.MiddlewareDefinition) {
    this.stack.push({ mw: handler, name })
  }

  async run(event: sdk.IO.Event) {
    for (const { mw, name } of this.stack) {
      let timedOut = false
      const timePromise = new Promise(() => {}).timeout(this.options.timeoutInMs).catch(() => {
        timedOut = true
      })
      const mwPromise = Promise.fromCallback<boolean>(cb => mw(event, cb), { multiArgs: true })
      const result = await Promise.race<Boolean[]>([timePromise, mwPromise])

      if (timedOut) {
        addStepToEvent(`mw:${name}:timedOut`, event)
        continue
      } else if (typeof result !== 'undefined') {
        const [swallow, skipped] = result as Boolean[]

        if (swallow) {
          addStepToEvent(`mw:${name}:swallowed`, event)
          break
        } else if (skipped) {
          addStepToEvent(`mw:${name}:skipped`, event)
        } else {
          addStepToEvent(`mw:${name}:completed`, event)
        }
      }
    }
  }
}
