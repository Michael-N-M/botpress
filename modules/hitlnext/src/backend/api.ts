import Axios from 'axios'
import * as sdk from 'botpress/sdk'
import { BPRequest } from 'common/http'
import { RequestWithUser } from 'common/typings'
import { Request, Response } from 'express'
import Joi from 'joi'
import _ from 'lodash'

import { MODULE_NAME } from '../constants'

import { HandoffType, IComment, IHandoff } from './../types'
import { UnprocessableEntityError } from './errors'
import { formatValidationError, makeAgentId } from './helpers'
import { StateType } from './index'
import Repository, { CollectionConditions } from './repository'
import Socket from './socket'
import {
  AgentOnlineValidation,
  AssignHandoffSchema,
  CreateCommentSchema,
  CreateHandoffSchema,
  ResolveHandoffSchema,
  validateHandoffStatusRule
} from './validation'

export default async (bp: typeof sdk, state: StateType) => {
  const router = bp.http.createRouterForBot(MODULE_NAME)
  const repository = new Repository(bp, state.timeouts)
  const realtime = Socket(bp)

  // Enforces for an agent to be 'online' before executing an action
  const agentOnlineMiddleware = async (req: BPRequest, res: Response, next) => {
    const { email, strategy } = req.tokenUser!
    const agentId = makeAgentId(strategy, email)
    const online = await repository.getAgentOnline(req.params.botId, agentId)

    try {
      Joi.attempt({ online }, AgentOnlineValidation)
    } catch (err) {
      if (err instanceof Joi.ValidationError) {
        return next(new UnprocessableEntityError(formatValidationError(err)))
      } else {
        return next(err)
      }
    }

    next()
  }

  // Catches exceptions and handles those that are expected
  const errorMiddleware = fn => {
    return (req: BPRequest, res: Response, next) => {
      Promise.resolve(fn(req as BPRequest, res, next)).catch(err => {
        if (err instanceof Joi.ValidationError) {
          throw new UnprocessableEntityError(formatValidationError(err))
        } else {
          next(err)
        }
      })
    }
  }

  const extendAgentSession = async (botId, agentId) => {
    return repository.setAgentOnline(botId, agentId, async () => {
      // By now the agent *should* be offline, but we check nonetheless
      const online = await repository.getAgentOnline(botId, agentId)
      const payload = {
        online
      }

      realtime.sendPayload(botId, {
        resource: 'agent',
        type: 'update',
        id: agentId,
        payload
      })
    })
  }

  // This should be available for all modules
  // The only thing we would need is a jsdoc comment @private on configs
  // we don't want to expose in some modules
  router.get(
    '/config',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const configs = await bp.config.getModuleConfigForBot(MODULE_NAME, req.params.botId)
      res.send(configs)
    })
  )

  router.get(
    '/agents/me',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!
      const payload = await repository.getCurrentAgent(req as BPRequest, req.params.botId, makeAgentId(strategy, email))
      res.send(payload)
    })
  )

  router.get(
    '/agents',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const agents = await repository.getAgents(req.params.botId, req.workspace)
      res.send(agents)
    })
  )

  router.post(
    '/agents/me/online',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!
      const agentId = makeAgentId(strategy, email)

      const online = await extendAgentSession(req.params.botId, agentId)

      const payload = { online }

      realtime.sendPayload(req.params.botId, {
        resource: 'agent',
        type: 'update',
        id: agentId,
        payload
      })

      res.send(payload)
    })
  )

  router.post(
    '/agents/me/offline',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!
      const agentId = makeAgentId(strategy, email)

      const online = await repository.unsetAgentOnline(req.params.botId, agentId)

      const payload = {
        online
      }

      realtime.sendPayload(req.params.botId, {
        resource: 'agent',
        type: 'update',
        id: agentId,
        payload
      })

      res.send(payload)
    })
  )

  router.get(
    '/handoffs',
    errorMiddleware(async (req: Request, res: Response) => {
      const handoffs = await repository.getHandoffsWithAssociations(
        req.params.botId,
        _.pick(req.query, ['limit', 'column', 'desc']) as CollectionConditions
      )
      res.send(handoffs)
    })
  )

  router.post(
    '/handoffs',
    errorMiddleware(async (req: Request, res: Response) => {
      const payload = {
        ..._.pick(req.body, ['userId', 'userThreadId', 'userChannel']),
        status: <HandoffType>'pending'
      }

      Joi.attempt(payload, CreateHandoffSchema)

      // Prevent creating a new handoff if one for the same conversation is currently active
      await repository
        .existingActiveHandoff(req.params.botId, payload.userId, payload.userThreadId, payload.userChannel)
        .then(existing => {
          if (existing) {
            return res.sendStatus(200)
          }
        })

      const handoff = await repository.createHandoff(req.params.botId, payload).then(handoff => {
        state.cacheHandoff(req.params.botId, handoff.userThreadId, handoff)
        return handoff
      })

      const eventDestination = {
        botId: req.params.botId,
        target: handoff.userId,
        threadId: handoff.userThreadId,
        channel: handoff.userChannel
      }

      bp.events.replyToEvent(
        eventDestination,
        await bp.cms.renderElement(
          'builtin_text',
          { type: 'text', text: 'You are being transfered to an agent.' },
          eventDestination
        )
      )

      realtime.sendPayload(req.params.botId, {
        resource: 'handoff',
        type: 'create',
        id: handoff.id,
        payload: handoff
      })

      res.status(201).send(handoff)
    })
  )

  router.post(
    '/handoffs/:id/assign',
    agentOnlineMiddleware,
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { botId } = req.params
      const { email, strategy } = req.tokenUser!

      const agentId = makeAgentId(strategy, email)

      let handoff: Partial<IHandoff> = await repository.getHandoffWithAssociations(req.params.botId, req.params.id)

      const axioxconfig = await bp.http.getAxiosConfigForBot(botId, { localUrl: true })
      const { data } = await Axios.post(`/mod/channel-web/conversations/${agentId}/new`, {}, axioxconfig)
      const agentThreadId = data.convoId.toString()
      const payload: Partial<IHandoff> = {
        agentId,
        agentThreadId,
        assignedAt: new Date(),
        status: 'assigned'
      }
      Joi.attempt(payload, AssignHandoffSchema)

      try {
        validateHandoffStatusRule(handoff.status, payload.status)
      } catch (e) {
        throw new UnprocessableEntityError(formatValidationError(e))
      }

      handoff = await repository.updateHandoff(req.params.botId, req.params.id, payload)
      state.cacheHandoff(req.params.botId, agentThreadId, handoff)

      await extendAgentSession(req.params.botId, agentId)

      const baseCustomEventPayload: Partial<sdk.IO.EventCtorArgs> = {
        botId: handoff.botId,
        direction: 'outgoing',
        type: 'custom',
        payload: {
          type: 'custom',
          module: MODULE_NAME
        }
      }

      // custom event to user
      bp.events.sendEvent(
        bp.IO.Event(
          _.merge(_.cloneDeep(baseCustomEventPayload), {
            target: handoff.userId,
            threadId: handoff.userThreadId,
            channel: handoff.userChannel,
            payload: { from: 'bot', component: 'HandoffAssignedForUser' }
          }) as sdk.IO.EventCtorArgs
        )
      )

      const recentEvents = await bp.events.findEvents(
        { botId, threadId: handoff.userThreadId },
        { count: 10, sortOrder: [{ column: 'id', desc: true }] }
      )

      // custom event to agent
      bp.events.sendEvent(
        bp.IO.Event(
          _.merge(_.cloneDeep(baseCustomEventPayload), {
            target: handoff.agentId,
            channel: 'web',
            threadId: handoff.agentThreadId,
            payload: {
              component: 'HandoffAssignedForAgent',
              recentEvents,
              noBubble: true,
              wrapped: { type: 'handoff' }
            } // super hack to make sure wrapper use our style, don't change this until fixed properly
          } as sdk.IO.EventCtorArgs)
        )
      )

      realtime.sendPayload(req.params.botId, {
        resource: 'handoff',
        type: 'update',
        id: handoff.id,
        payload: handoff
      })

      res.send(handoff)
    })
  )

  router.post(
    '/handoffs/:id/resolve',
    agentOnlineMiddleware,
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!

      const agentId = makeAgentId(strategy, email)

      let handoff
      handoff = await repository.getHandoffWithAssociations(req.params.botId, req.params.id)

      const payload: Partial<IHandoff> = {
        status: 'resolved',
        resolvedAt: new Date()
      }

      Joi.attempt(payload, ResolveHandoffSchema)

      try {
        validateHandoffStatusRule(handoff.status, payload.status)
      } catch (e) {
        throw new UnprocessableEntityError(formatValidationError(e))
      }

      handoff = await repository.updateHandoff(req.params.botId, req.params.id, payload).then(handoff => {
        state.expireHandoff(req.params.botId, handoff.userThreadId)
        return handoff
      })

      await extendAgentSession(req.params.botId, agentId)

      realtime.sendPayload(req.params.botId, {
        resource: 'handoff',
        type: 'update',
        id: handoff.id,
        payload: handoff
      })

      res.send(handoff)
    })
  )

  router.post(
    '/handoffs/:id/comments',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!
      const agentId = makeAgentId(strategy, email)

      const handoff = await repository.getHandoffWithAssociations(req.params.botId, req.params.id)

      const payload: IComment = {
        ...req.body,
        handoffId: handoff.id,
        threadId: handoff.userThreadId,
        agentId
      }

      Joi.attempt(payload, CreateCommentSchema)

      const comment = await repository.createComment(payload)
      handoff.comments = [...handoff.comments, comment]

      realtime.sendPayload(req.params.botId, {
        resource: 'handoff',
        type: 'update',
        id: handoff.id,
        payload: handoff
      })

      await extendAgentSession(req.params.botId, agentId)

      res.status(201).send(comment)
    })
  )

  router.get(
    '/conversations/:id/messages',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      req.tokenUser!

      const messages = await repository.getMessages(
        req.params.botId,
        req.params.id,
        _.pick(req.query, ['limit', 'column', 'desc']) as CollectionConditions
      )

      res.send(messages)
    })
  )
}