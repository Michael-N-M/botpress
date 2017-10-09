import React, { Component } from 'react'
import classnames from 'classnames'
import axios from 'axios'
import _ from 'lodash'

import ContentWrapper from '~/components/Layout/ContentWrapper'
import PageHeader from '~/components/Layout/PageHeader'

import Toolbar from './toolbar'
import Diagram from './diagram'

const style = require('./style.scss')

export default class FlowBuilder extends Component {
  constructor(props) {
    super(props)
    this.state = {
      flowName: 'Untitled Flow'
    }
  }

  componentDidMount() {}

  onFlowNameChanged(event) {
    this.setState({
      flowName: event.target.value
    })
  }

  onFlowNameKey(event) {
    if (event.keyCode === 13) {
      // Enter
      event.target.blur()
    }
  }

  onFlowNameBlur(event) {
    if (!this.state.flowName.length) {
      this.setState({
        flowName: 'Untitled Flow'
      })
    }
  }

  render() {
    //<span>Flow Builder</span>

    const inputWidth = Math.max(120, 20 + 8 * this.state.flowName.length) + 'px'
    const inputClass = classnames({
      [style.flowName]: true,
      [style.defaultValue]: this.state.flowName === 'Untitled Flow'
    })
    return (
      <ContentWrapper stretch={true} className={style.wrapper}>
        <PageHeader className={style.header} width="100%">
          <input
            className={inputClass}
            type="text"
            style={{ width: inputWidth }}
            autocomplete="off"
            value={this.state.flowName}
            onBlur={::this.onFlowNameBlur}
            onChange={::this.onFlowNameChanged}
            onKeyDown={::this.onFlowNameKey}
          />
        </PageHeader>
        <Toolbar />
        <div className={style.diagram}>
          <Diagram />
        </div>
      </ContentWrapper>
    )
  }
}
