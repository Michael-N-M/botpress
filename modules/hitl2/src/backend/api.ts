import Axios from 'axios'
import * as sdk from 'botpress/sdk'
import { BPRequest } from 'common/http'
import { RequestWithUser } from 'common/typings'
import { Request, Response } from 'express'
import Joi from 'joi'
import _ from 'lodash'
import ms from 'ms'
import yn from 'yn'

import { CommentType, EscalationType } from './../types'
import { ResponseError, UnprocessableEntityError } from './errors'
import { formatError, makeAgentId } from './helpers'
import { StateType } from './index'
import Repository, { AgentCollectionConditions, CollectionConditions } from './repository'
import socket from './socket'
import {
  AgentOnlineValidation,
  AssignEscalationSchema,
  CreateCommentSchema,
  CreateEscalationSchema,
  ResolveEscalationSchema,
  validateEscalationStatusRule
} from './validation'

export default async (bp: typeof sdk, state: StateType) => {
  const router = bp.http.createRouterForBot('hitl2')
  const repository = new Repository(bp)
  const realtime = socket(bp)
  const debug = DEBUG('hitl2')

  // Enforces for an agent to be 'online' before executing an action
  const agentOnlineMiddleware = async (req: BPRequest, res: Response, next) => {
    const { email, strategy } = req.tokenUser!
    const agentId = makeAgentId(strategy, email)
    const online = await repository.getAgentOnline(req.params.botId, agentId)

    try {
      Joi.attempt({ online }, AgentOnlineValidation)
    } catch (err) {
      if (err instanceof Joi.ValidationError) {
        return formatError(res, new UnprocessableEntityError(err))
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
        if (err instanceof ResponseError) {
          formatError(res, err)
        } else if (err instanceof Joi.ValidationError) {
          formatError(res, new UnprocessableEntityError(err))
        } else {
          next(err)
        }
      })
    }
  }

  // Fires a realtime event when an agent's session is expired
  const registerTimeout = async (botId: string, agentId: string) => {
    debug.forBot(botId, 'Registering timeout', { agentId })

    const { agentSessionTimeout } = await bp.config.getModuleConfigForBot('hitl2', botId)

    // Clears previously registered timeout to avoid old timers to execute
    unregisterTimeout(agentId)

    state.timeouts[agentId] = setTimeout(async () => {
      // By now the agent *should* be offline, but we check nonetheless
      const online = await repository.getAgentOnline(botId, agentId)
      const payload = { online }

      realtime.sendPayload({
        resource: 'agent',
        type: 'update',
        id: agentId,
        payload
      })
    }, ms(agentSessionTimeout as string))
  }

  const unregisterTimeout = (agentId: string) => {
    if (state.timeouts[agentId]) {
      clearTimeout(state.timeouts[agentId])
    }
  }

  router.get(
    '/agents/me',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!
      const payload = await repository.getCurrentAgent(req, req.params.botId, makeAgentId(strategy, email))
      res.send(payload)
    })
  )

  router.get(
    '/agents',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const agents = await repository.getAgents(
        req.params.botId,
        _.tap(_.pick(req.query, 'online'), conditions => {
          if (conditions.online) {
            conditions.online = yn(conditions.online)
          }
        }) as AgentCollectionConditions
      )
      res.send(agents)
    })
  )

  router.post(
    '/agents/me/online',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!
      const agentId = makeAgentId(strategy, email)

      const online = await repository.setAgentOnline(req.params.botId, agentId, true)
      await registerTimeout(req.params.botId, agentId)

      const payload = { online }

      realtime.sendPayload({
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

      const online = await repository.setAgentOnline(req.params.botId, agentId, false)
      unregisterTimeout(agentId)

      const payload = {
        online
      }

      realtime.sendPayload({
        resource: 'agent',
        type: 'update',
        id: agentId,
        payload
      })

      res.send(payload)
    })
  )

  router.get(
    '/escalations',
    errorMiddleware(async (req: Request, res: Response) => {
      const escalations = await repository.getEscalationsWithComments(
        req.params.botId,
        _.pick(req.query, ['limit', 'column', 'desc']) as CollectionConditions
      )
      res.send(escalations)
    })
  )

  router.post(
    '/escalations',
    errorMiddleware(async (req: Request, res: Response) => {
      const payload = {
        ..._.pick(req.body, ['userId', 'userThreadId']),
        status: 'pending' as 'pending'
      }

      Joi.attempt(payload, CreateEscalationSchema)

      // Prevent creating a new escalation if one is currently pending or assigned
      let escalation = await repository
        .escalationsQuery(builder => {
          return builder
            .where('botId', req.params.botId)
            .andWhere('userId', payload.userId)
            .andWhere('userThreadId', payload.userThreadId)
            .whereNot('status', 'resolved')
            .orderBy('createdAt')
            .limit(1)
        })
        .then(data => _.head(data) as EscalationType)

      if (escalation) {
        return res.sendStatus(200)
      }

      escalation = await repository.createEscalation(req.params.botId, payload).then(escalation => {
        state.cacheEscalation(req.params.botId, escalation.userThreadId, escalation)
        return escalation
      })

      realtime.sendPayload({
        resource: 'escalation',
        type: 'create',
        id: escalation.id,
        payload: escalation
      })

      res.status(201).send(escalation)
    })
  )

  router.post(
    '/escalations/:id/assign',
    agentOnlineMiddleware,
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { botId } = req.params
      const { email, strategy } = req.tokenUser!

      const agentId = makeAgentId(strategy, email)

      let escalation: Partial<EscalationType> = await repository.getEscalationWithComments(
        req.params.botId,
        req.params.id
      )

      const axioxconfig = await bp.http.getAxiosConfigForBot(botId)
      const { data } = await Axios.post(`/mod/channel-web/conversations/${agentId}/new`, {}, axioxconfig)
      const agentThreadId = data.convoId.toString()
      const payload: Partial<EscalationType> = {
        agentId,
        agentThreadId,
        assignedAt: new Date(),
        status: 'assigned'
      }
      Joi.attempt(payload, AssignEscalationSchema)

      try {
        validateEscalationStatusRule(escalation.status, payload.status)
      } catch (e) {
        throw new UnprocessableEntityError(e)
      }

      escalation = await repository.updateEscalation(req.params.botId, req.params.id, payload)
      state.cacheEscalation(req.params.botId, agentThreadId, escalation)

      // Bump agent session timeout
      await repository.setAgentOnline(req.params.botId, agentId, true)
      await registerTimeout(req.params.botId, agentId)

      realtime.sendPayload({
        resource: 'escalation',
        type: 'update',
        id: escalation.id,
        payload: escalation
      })

      res.send(escalation)
    })
  )

  router.post(
    '/escalations/:id/resolve',
    agentOnlineMiddleware,
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!

      const agentId = makeAgentId(strategy, email)

      let escalation
      escalation = await repository.getEscalationWithComments(req.params.botId, req.params.id)

      const payload: Partial<EscalationType> = {
        status: 'resolved',
        resolvedAt: new Date()
      }

      Joi.attempt(payload, ResolveEscalationSchema)

      try {
        validateEscalationStatusRule(escalation.status, payload.status)
      } catch (e) {
        throw new UnprocessableEntityError(e)
      }

      escalation = await repository.updateEscalation(req.params.botId, req.params.id, payload).then(escalation => {
        state.expireEscalation(req.params.botId, escalation.userThreadId)
        return escalation
      })

      await repository.setAgentOnline(req.params.botId, agentId, true) // Bump agent session timeout
      await registerTimeout(req.params.botId, agentId)

      realtime.sendPayload({
        resource: 'escalation',
        type: 'update',
        id: escalation.id,
        payload: escalation
      })

      res.send(escalation)
    })
  )

  router.post(
    '/escalations/:id/comments',
    errorMiddleware(async (req: RequestWithUser, res: Response) => {
      const { email, strategy } = req.tokenUser!
      const agentId = makeAgentId(strategy, email)

      const payload: CommentType = {
        ...req.body,
        escalationId: req.params.id,
        agentId
      }

      Joi.attempt(payload, CreateCommentSchema)

      const comment = await repository.createComment(payload)

      await repository.setAgentOnline(req.params.botId, agentId, true) // Bump agent session timeout
      await registerTimeout(req.params.botId, agentId)

      res.status(201)
      res.send(comment)
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