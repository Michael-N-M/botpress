import { AxiosError } from 'axios'
import { Dictionary } from 'lodash'
import React, { createContext, Dispatch, useReducer } from 'react'

import { Config } from '../../../config'
import { IAgent, IEscalation } from '../../../types'

import Reducer, { ActionType } from './Reducer'

interface IStore {
  state: IState
  dispatch: Dispatch<ActionType>
}

export interface UserDefaultsType {
  [key: string]: {
    username: string
  }
}

export interface IState {
  readonly currentAgent?: IAgent
  readonly currentEscalation?: IEscalation
  readonly agents: Dictionary<IAgent>
  readonly escalations: Dictionary<IEscalation>
  readonly reads: Dictionary<Date>
  readonly config?: Config
  readonly defaults: {
    user?: UserDefaultsType
  }
  readonly error?: AxiosError<Error>
}

const initialState: IState = {
  currentAgent: null,
  currentEscalation: null,
  agents: {},
  escalations: {},
  reads: {},
  config: null,
  defaults: {},
  error: null
}

export const Context = createContext<IStore>({ state: initialState, dispatch: () => null })

export const Store = ({ children }) => {
  const [state, dispatch] = useReducer(Reducer, initialState)
  return <Context.Provider value={{ state, dispatch }}>{children}</Context.Provider>
}