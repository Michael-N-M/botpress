import { Text } from '@blueprintjs/core'
import { lang } from 'botpress/shared'
import cx from 'classnames'
import _ from 'lodash'
import moment from 'moment'
import React, { FC, useContext, useEffect, useState } from 'react'

import { IEscalation } from '../../../../types'
import { Context } from '../Store'

import style from './../../style.scss'
import { generateUsername, getOrSet } from './../utils'
import EscalationBadge from './EscalationBadge'

const EscalationItem: FC<IEscalation> = props => {
  const { createdAt, id, status, agentId, userConversation } = props

  const { state, dispatch } = useContext(Context)

  const [defaultUsername, setDefaultUsername] = useState()
  const [readStatus, setReadStatus] = useState(false)
  const [fromNow, setFromNow] = useState(moment(createdAt).fromNow())

  async function handleSelect(id: string) {
    dispatch({ type: 'setCurrentEscalation', payload: id })
    dispatch({
      type: 'setRead',
      payload: {
        [id]: state.escalations[id].userConversation.createdOn
      }
    })
    setReadStatus(true)
  }

  useEffect(() => {
    const refreshRate = 1000 * 60 // ms

    const interval = setInterval(() => {
      setFromNow(moment(createdAt).fromNow())
    }, refreshRate)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (state.currentEscalation?.id === id) {
      setReadStatus(true)
    } else if (state.reads[id] && state.reads[id] < userConversation.createdOn) {
      setReadStatus(false)
    }
  }, [userConversation])

  useEffect(() => {
    const key = _.get(userConversation.event, 'target')
    const username = getOrSet(
      () => {
        return _.get(state, `defaults.user.${key}.username`)
      },
      value => {
        dispatch({
          type: 'setDefault',
          payload: {
            user: {
              [key]: {
                username: value
              }
            }
          }
        })
      },
      generateUsername()
    )

    setDefaultUsername(username)
  }, [userConversation])

  const userName = () => {
    return _.get(userConversation.event, 'state.user.fullName') || state.config.defaultUsername
      ? defaultUsername
      : lang.tr('module.hitlnext.user.anonymous')
  }

  const agentName = () => {
    if (agentId && agentId === state.currentAgent?.agentId) {
      return lang.tr('module.hitlnext.escalation.you')
    } else if (agentId) {
      const agent = state.agents[agentId]
      return [agent.attributes.firstname, agent.attributes.lastname].filter(Boolean).join(' ')
    }
  }

  return (
    <div
      className={cx(style.escalationItem, { [style.active]: state.currentEscalation?.id == id })}
      onClick={() => handleSelect(id)}
    >
      {!readStatus && <span className={style.unreadDot}></span>}
      <div className={style.info}>
        <span className={style.clientName}>{userName()}</span> <strong>#{id}</strong>
        <p>
          <span>From {userConversation.channel}</span> {agentId && '⋅'} <span>{agentName()}</span>
        </p>
        <Text ellipsize={true}>{_.get(userConversation, 'event.preview')}</Text>
        <p className={style.createdDate}>{fromNow}</p>
      </div>
      <div className={style.badge}>
        <EscalationBadge status={status}></EscalationBadge>
      </div>
    </div>
  )
}

export default EscalationItem
