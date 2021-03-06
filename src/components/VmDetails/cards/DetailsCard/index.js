import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'

import * as Actions from '../../../../actions'
import { MAX_VM_MEMORY_FACTOR } from '../../../../constants'
import { generateUnique, localeCompare } from '../../../../helpers'
import { msg, enumMsg } from '../../../../intl'
import {
  formatUptimeDuration,
  convertValue,
  isNumber,
  round,
} from '../../../../utils'
import {
  canChangeCluster as vmCanChangeCluster,
  canChangeCd as vmCanChangeCd,
} from '../../../../vm-status'

import { isValidOsIcon } from '../../../utils'

import {
  Alert,
  FieldLevelHelp,
  FormControl,
  Icon,
  OverlayTrigger,
  Tooltip,
} from 'patternfly-react'
import Switch from '../../../Switch'
import SelectBox from '../../../SelectBox'
import VmStatusIcon from '../../../VmStatusIcon'
import BaseCard from '../../BaseCard'
import { Grid, Row, Col } from '../../GridComponents'

import style from './style.css'

import ConsoleList from './ConsoleList'
import HotPlugChangeConfirmationModal from './HotPlugConfirmationModal'
import NextRunChangeConfirmationModal from './NextRunChangeConfirmationModal'

/*
 * Return a normalized list of iso files from the set of provided storage domains.
 */
function createIsoList (storageDomains) {
  const list = []

  storageDomains.forEach(storageDomain => {
    if (storageDomain.has('files')) {
      storageDomain.get('files').forEach(file => {
        list.push({
          sd: {
            id: storageDomain.get('id'),
            name: storageDomain.get('name'),
          },
          file: {
            id: file.id,
            name: file.name,
          },
        })
      })
    }
  })

  return list
}

/*
 * Return a normalized and sorted list of clusters ready for use in a __SelectBox__ from
 * the Map of provided clusters.
 */
function createClusterList (clusters) {
  const clusterList =
    clusters
      .toList()
      .filter(cluster => cluster.get('canUserUseCluster'))
      .map(cluster => ({
        id: cluster.get('id'),
        value: cluster.get('name'),
        datacenter: cluster.get('dataCenterId'),
      }))
      .sort((a, b) => localeCompare(a.value, b.value))
      .toJS()

  return clusterList
}

/*
 * Return a normalized and sorted list of templates ready for use in a __SelectBox__ from
 * the Map of provided templates.
 */
function createTemplateList (templates) {
  const templateList =
    templates
      .toList()
      .map(template => ({
        id: template.get('id'),
        value: template.get('name'),
      }))
      .sort((a, b) => localeCompare(a.value, b.value))
      .toJS()

  return templateList
}

function rephraseVmType (vmType) {
  const types = {
    'desktop': msg.vmType_desktop(),
    'server': msg.vmType_server(),
    'highperformance': msg.vmType_highPerformance(),
  }

  const type = vmType.toLowerCase()
  if (type in types) {
    return types[type]
  }

  return vmType
}

/*
 * Render a label plus children as a single grid row with 2 columns.
 */
const FieldRow = ({ label, children, id }) => (
  <Row className={style['field-row']}>
    <Col cols={5} className={style['col-label']}>{label}</Col>
    <Col cols={7} className={style['col-data']} id={id}>{children}</Col>
  </Row>
)
FieldRow.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
}

/*
 * Render "N/A" with an optional tooltip for any field that won't have a value
 * based on the state of the VM.
 */
const NotAvailable = ({ tooltip, id }) => (
  <div>
    { tooltip
      ? (
        <OverlayTrigger overlay={<Tooltip id={id}>{tooltip}</Tooltip>}>
          <span>{msg.notAvailable()}</span>
        </OverlayTrigger>
      )
      : (
        <span id={id}>{msg.notAvailable()}</span>
      )
    }
  </div>
)
NotAvailable.propTypes = {
  tooltip: PropTypes.string,
  id: PropTypes.string.isRequired,
}

/*
 * Specific information and details of the VM (status/up-time, data center, cluster,
 * host, template, IP addresses, FQDN, CD, consoles, memory, CPUs, cloud-init, boot menu,
 * boot order)
 */
class DetailsCard extends React.Component {
  constructor (props) {
    super(props)

    this.state = {
      vm: props.vm, // ImmutableJS Map

      isEditing: false,
      isDirty: false,
      correlationId: null,
      correlatedMessages: null,

      promptHotPlugChanges: false,
      promptNextRunChanges: false,

      isoList: createIsoList(props.storageDomains),
      clusterList: createClusterList(props.clusters),
      templateList: createTemplateList(props.templates),
    }
    this.trackUpdates = {}
    this.hotPlugUpdates = {}
    this.hotPlugNow = true
    this.nextRunUpdates = {}
    this.restartAfterSave = false

    this.handleCardOnStartEdit = this.handleCardOnStartEdit.bind(this)
    this.handleChange = this.handleChange.bind(this)
    this.handleCardOnCancel = this.handleCardOnCancel.bind(this)
    this.handleCardOnSave = this.handleCardOnSave.bind(this)

    this.handleNextRunOnCancel = this.handleNextRunOnCancel.bind(this)
    this.handleNextRunOnSave = this.handleNextRunOnSave.bind(this)
    this.handleNextRunOnSaveAndRestart = this.handleNextRunOnSaveAndRestart.bind(this)
    this.handleHotPlugOnCancel = this.handleHotPlugOnCancel.bind(this)
    this.handleHotPlugOnApplyLater = this.handleHotPlugOnApplyLater.bind(this)
    this.handleHotPlugOnApplyNow = this.handleHotPlugOnApplyNow.bind(this)
  }

  static getDerivedStateFromProps (props, state) {
    if (!state.isEditing) {
      return {
        vm: props.vm,
      }
    }

    // Check the results of the saveChanges call and either setup to drop out of
    // edit mode, or pull the error messages to display on the card.
    if (state.isEditing && state.correlationId && props.vm.hasIn(['actionResults', state.correlationId])) {
      const actionResult = props.vm.getIn(['actionResults', state.correlationId])
      if (actionResult) {
        return { isEditing: false, isDirty: false, correlationId: null, correlatedMessages: null }
      }
      return {
        correlatedMessages: props.userMessages.get('records').filter(
          record => record.getIn([ 'failedAction', 'meta', 'correlationId' ]) === state.correlationId
        ),
      }
    }

    return null
  }

  componentDidUpdate (prevProps, prevState) {
    if (prevState.isEditing && !this.state.isEditing) {
      this.props.onEditChange(false)
    }

    // NOTE: Doing the following here instead of getDerivedStateFromProps so __clusters__,
    //       __storageDomains__, and __templates__ don't need to be kept in state for
    //       change comparison
    if (prevProps.clusters !== this.props.clusters) {
      this.setState({ clusterList: createClusterList(this.props.clusters) }) // eslint-disable-line react/no-did-update-set-state
    }

    if (prevProps.storageDomains !== this.props.storageDomains) {
      this.setState({ isoList: createIsoList(this.props.storageDomains) }) // eslint-disable-line react/no-did-update-set-state
    }

    if (prevProps.templates !== this.props.templates) {
      this.setState({ templateList: createTemplateList(this.props.templates) }) // eslint-disable-line react/no-did-update-set-state
    }
  }

  handleCardOnStartEdit () {
    this.trackUpdates = {}
    this.hotPlugUpdates = {}
    this.nextRunUpdates = {}
    this.setState({
      isEditing: true,
      isDirty: false,
      correlationId: null,
      correlatedMessages: null,
      promptHotPlugChanges: false,
      promptNextRunChanges: false,
    })
    this.props.onEditChange(true)
  }

  handleChange (fieldName, value) {
    if (this.state.isEditing && !this.state.isDirty) {
      this.props.onEditChange(true, true)
    }

    let updates = this.state.vm
    const changeQueue = [{ fieldName, value }]
    for (let change = changeQueue.shift(); change; change = changeQueue.shift()) {
      console.log('processing change', change)
      const { fieldName, value } = change

      let fieldUpdated
      switch (fieldName) {
        case 'cluster':
          updates = updates.set('cluster', this.props.clusters.get(value))
          fieldUpdated = 'cluster'

          // Change the template to 'Blank' if the VM's template isn't in the new cluster
          {
            const template = this.props.templates.get(updates.getIn(['template', 'id']))
            if (template && template.get('clusterId') && template.get('clusterId') !== value) {
              changeQueue.push({ fieldName: 'template', value: this.props.blankTemplateId })
            }
          }
          break

        case 'template':
          updates = updates.set('template', this.props.templates.get(value))
          fieldUpdated = 'template'

          // Apply settings from the template to the VM (memory, CPUs, OS, cloudInit, bootMenuEnabled)
          {
            const template = this.props.templates.get(value)
            if (template) {
              // fields that are editable on the card
              changeQueue.push(
                { fieldName: 'memory', value: template.get('memory') / (1024 ** 3) }, // input assumed to be GiB
                { fieldName: 'cpu', value: template.getIn(['cpu', 'vCPUs']) },
                { fieldName: 'bootMenuEnabled', value: template.get('bootMenuEnabled') },
              )

              // fields that need to be changed but are not on the card
              const operatingSystems = this.props.operatingSystems
              const osType = template.getIn(['os', 'type'], 'other')
              const templateOs = operatingSystems.find(os => os.get('name') === osType)
              if (templateOs) {
                updates = updates.mergeDeep({
                  os: {
                    type: osType,
                  },
                })

                const templateOsIconId = templateOs.getIn(['icons', 'large', 'id'])
                const currentOsIconId = updates.getIn(['icons', 'large', 'id'])
                if (currentOsIconId && isValidOsIcon(operatingSystems, currentOsIconId)) {
                  updates = updates.mergeDeep({
                    icons: {
                      large: {
                        id: templateOsIconId,
                      },
                    },
                  })
                }
              }

              // TODO: When could-init editing is added, make this look like the other followup changes
              const cloudInit = template.get('cloudInit').toJS()
              updates = updates.set('cloudInit', cloudInit)
            }
          }
          break

        case 'cdrom':
          updates = updates.setIn(['cdrom', 'fileId'], value)
          fieldUpdated = 'cdrom'
          break

        case 'bootMenuEnabled':
          updates = updates.set('bootMenuEnabled', value)
          fieldUpdated = 'bootMenuEnabled'
          this.nextRunUpdates['bootMenuEnabled'] = true
          // TODO? If the switch gets changed twice and it's back to its original state,
          //       should it get flagged as a change?
          break

        case 'cpu':
          if (isNumber(value) && value > 0) {
            updates = updates.mergeDeep({
              'cpu': {
                'topology': { // NOTE: this may not match VM's template's topology
                  'sockets': +value,
                  'cores': 1,
                  'threads': 1,
                },
                'vCPUs': +value, // === sockets * cores * threads
              },
            })
            fieldUpdated = 'cpu'
            this.hotPlugUpdates['cpu'] = true
          }
          break

        case 'memory':
          if (isNumber(value) && value > 0) {
            const asBytes = value * (1024 ** 3) // input assumed to be GiB
            updates = updates.setIn(['memory', 'total'], asBytes)
            fieldUpdated = 'memory'
            this.hotPlugUpdates['memory'] = true
          }
          break
      }

      if (updates !== this.state.vm) {
        this.trackUpdates[fieldUpdated] = true
        this.setState({ vm: updates, isDirty: true })
      }
    } // for
  }

  handleCardOnCancel () {
    this.setState({ isEditing: false, isDirty: false, correlationId: null, correlatedMessages: null })
    this.props.onEditChange(false)
  }

  handleCardOnSave () {
    const isVmRunning = this.props.vm.get('status') === 'up'

    if (Object.keys(this.trackUpdates).length === 0) {
      this.handleCardOnCancel()
      return
    }

    // Prompt on the hot-plug field changes. The answer there will update state and run this function again
    if (isVmRunning && Object.values(this.hotPlugUpdates).find(value => value)) {
      this.setState({ promptHotPlugChanges: true })
      return
    }

    // Prompt on the next-run field changes. The answer there will update state and run this function again
    if (isVmRunning && Object.values(this.nextRunUpdates).find(value => value)) {
      this.setState({ promptNextRunChanges: true })
      return
    }

    const { vm: stateVm } = this.state
    const correlationId = generateUnique('DetailsCard-save_')

    // --- Create a partial VM (in the internal format expected by editVm() saga),
    //     only including the fields that have been updated
    const vmUpdates = { id: stateVm.get('id') }

    if (this.trackUpdates['cluster']) {
      vmUpdates['cluster'] = {
        id: stateVm.getIn([ 'cluster', 'id' ]),
      }
    }

    if (this.trackUpdates['template']) {
      vmUpdates['template'] = {
        id: stateVm.getIn([ 'template', 'id' ]),
      }
    }

    // NOTE: The cdrom change could be spun off to its own redux dispatch, but doing so would
    //       complicate the correlation tracking that needs to be done (2 changes to track
    //       instead of one).  Right now, if only the CD is changed, 2 calls will still be
    //       made.  First an editVm with an empty change.  Second the changeCd.
    if (this.trackUpdates['cdrom']) {
      vmUpdates['cdrom'] = {
        fileId: stateVm.getIn(['cdrom', 'fileId']),
      }
    }

    if (this.trackUpdates['bootMenuEnabled']) {
      vmUpdates['bootMenuEnabled'] = stateVm.get('bootMenuEnabled')
    }

    if (this.trackUpdates['cpu']) {
      vmUpdates['cpu'] = {
        topology: stateVm.getIn(['cpu', 'topology']).toJS(),
      }
    }

    if (this.trackUpdates['memory']) {
      const cluster = this.props.clusters.get(stateVm.getIn(['cluster', 'id']))
      const stateMemory = stateVm.getIn(['memory', 'total'])
      const overCommitPercent = cluster && cluster.getIn(['memoryPolicy', 'overCommitPercent'])
      const guaranteed = overCommitPercent ? (stateMemory * (100 / overCommitPercent)) : stateMemory

      vmUpdates['memory'] = stateMemory
      vmUpdates['memory_policy'] = {
        'max': stateMemory * MAX_VM_MEMORY_FACTOR,
        'guaranteed': Math.round(guaranteed),
      }
    }

    // ---- dispatch the save
    this.setState({ correlationId })
    this.props.saveChanges(vmUpdates, this.restartAfterSave, !this.hotPlugNow, correlationId)

    return false // control BaseCard's view/edit transition
  }

  handleNextRunOnCancel () {
    this.setState({ promptNextRunChanges: false })
  }

  handleNextRunOnSave () {
    this.nextRunUpdates = {}
    this.restartAfterSave = false
    this.setState({ promptNextRunChanges: false })
    this.handleCardOnSave()
  }

  handleNextRunOnSaveAndRestart () {
    this.nextRunUpdates = {}
    this.restartAfterSave = true
    this.setState({ promptNextRunChanges: false })
    this.handleCardOnSave()
  }

  handleHotPlugOnCancel () {
    this.setState({ promptHotPlugChanges: false })
  }

  handleHotPlugOnApplyLater () {
    this.hotPlugUpdates = {}
    this.hotPlugNow = false
    this.setState({ promptHotPlugChanges: false })
    this.handleCardOnSave()
  }

  handleHotPlugOnApplyNow () {
    this.hotPlugUpdates = {}
    this.hotPlugNow = true
    this.setState({ promptHotPlugChanges: false })
    this.handleCardOnSave()
  }

  render () {
    const { hosts, clusters, dataCenters, templates } = this.props
    const { vm, isEditing, correlatedMessages, clusterList, isoList, templateList } = this.state

    const idPrefix = 'vmdetail-details'

    const canEditDetails =
      vm.get('canUserEditVm') &&
      vm.getIn(['pool', 'id']) === undefined

    const status = vm.get('status')
    const uptime = formatUptimeDuration({ start: vm.get('startTime') })

    const hostName = hosts && hosts.getIn([vm.get('hostId'), 'name'])

    const ip4Addresses = !vm.has('nics') ? [] : vm.get('nics').reduce((ipSet, nic) => [...ipSet, ...nic.get('ipv4')], [])
    const ip6Addresses = !vm.has('nics') ? [] : vm.get('nics').reduce((ipSet, nic) => [...ipSet, ...nic.get('ipv6')], [])

    const fqdn = vm.get('fqdn')

    const canChangeCluster = vmCanChangeCluster(status)
    const clusterId = vm.getIn(['cluster', 'id'])
    const clusterName = (clusters && clusters.getIn([clusterId, 'name'])) || msg.notAvailable()

    const dataCenterId = (clusters && clusters.getIn([clusterId, 'dataCenterId']))
    const dataCenter = dataCenters && dataCenters.find(v => v.id === dataCenterId)
    const dataCenterName = (dataCenter && dataCenter.name) || msg.notAvailable()

    const templateId = vm.getIn(['template', 'id'])
    const templateName = (templates && templates.getIn([templateId, 'name'])) || msg.notAvailable()

    const canChangeCd = vmCanChangeCd(status)
    const cdImageId = vm.getIn(['cdrom', 'fileId'])
    const cdImage = isoList.find(iso => iso.file.id === cdImageId)
    const cdImageName = (cdImage && cdImage.file.name) || `[${msg.empty()}]`

    const couldInitEnabled = vm.getIn(['cloudInit', 'enabled'])

    const bootMenuEnabled = vm.get('bootMenuEnabled')

    const optimizedFor = rephraseVmType(vm.get('type'))

    const vCpuCount = vm.getIn(['cpu', 'vCPUs'])

    const { unit: memoryUnit, value: memorySize } = convertValue('B', vm.getIn(['memory', 'total']))

    return <React.Fragment>
      <NextRunChangeConfirmationModal
        show={this.state.promptNextRunChanges}
        onCancel={this.handleNextRunOnCancel}
        onSave={this.handleNextRunOnSave}
        onSaveAndRestart={this.handleNextRunOnSaveAndRestart}
      />
      <HotPlugChangeConfirmationModal
        show={this.state.promptHotPlugChanges}
        onCancel={this.handleHotPlugOnCancel}
        onApplyLater={this.handleHotPlugOnApplyLater}
        onApplyNow={this.handleHotPlugOnApplyNow}
      />
      <BaseCard
        title={msg.cardTitleDetails()}
        editable={canEditDetails}
        editMode={isEditing}
        idPrefix={idPrefix}
        editTooltip={msg.cardTooltipEditDetails({ vmId: vm.get('id') })}
        onStartEdit={this.handleCardOnStartEdit}
        onCancel={this.handleCardOnCancel}
        onSave={this.handleCardOnSave}
      >
        {({ isEditing }) =>
          <React.Fragment>
            <Grid className={style['details-container']}>
              <Row>
                <Col className={style['fields-column']}>
                  <Grid>
                    <FieldRow label={msg.status()} id={`${idPrefix}-status`}>
                      <div className={style['vm-status']}>
                        <VmStatusIcon className={style['vm-status-icon']} state={vm.get('status')} />
                        <span className={style['vm-status-text']}>{enumMsg('VmStatus', vm.get('status'))}</span>
                      </div>
                      { uptime && <div className={style['vm-uptime']} id={`${idPrefix}-uptime`}>(up {uptime})</div> }
                    </FieldRow>
                    <FieldRow label={msg.host()} id={`${idPrefix}-host`}>
                      { hostName || <NotAvailable tooltip={msg.notAvailableUntilRunning()} id={`${idPrefix}-host-not-available`} /> }
                    </FieldRow>
                    <FieldRow label={msg.ipAddress()} id={`${idPrefix}-ip`}>
                      <React.Fragment>
                        { ip4Addresses.length === 0 && ip6Addresses.length === 0 &&
                          <NotAvailable tooltip={msg.notAvailableUntilRunningAndGuestAgent()} id={`${idPrefix}-ip-not-available`} />
                        }
                        { ip4Addresses.length > 0 &&
                          ip4Addresses.map((ip4, index) => <div key={`ip4-${index}`} id={`${idPrefix}-ip-ipv4-${index}`}>{ip4}</div>)
                        }
                        { ip6Addresses.length > 0 &&
                          ip6Addresses.map((ip4, index) => <div key={`ip4-${index}`} id={`${idPrefix}-ip-ipv6-${index}`}>{ip4}</div>)
                        }
                      </React.Fragment>
                    </FieldRow>
                    <FieldRow label={msg.fqdn()} id={`${idPrefix}-fqdn`}>
                      { fqdn || <NotAvailable tooltip={msg.notAvailableUntilRunningAndGuestAgent()} id={`${idPrefix}-fqdn-not-available`} /> }
                    </FieldRow>
                    <FieldRow label={msg.cluster()} id={`${idPrefix}-cluster`}>
                      { !isEditing && clusterName }
                      { isEditing && !canChangeCluster &&
                        <div>
                          {clusterName}
                          <FieldLevelHelp disabled={false} content={msg.clusterCanOnlyChangeWhenVmStopped()} inline />
                        </div>
                      }
                      { isEditing && canChangeCluster &&
                        <SelectBox
                          id={`${idPrefix}-cluster-edit`}
                          items={clusterList.filter(cluster => cluster.datacenter === dataCenterId)}
                          selected={clusterId}
                          onChange={(selectedId) => { this.handleChange('cluster', selectedId) }}
                        />
                      }
                    </FieldRow>
                    <FieldRow label={msg.dataCenter()} id={`${idPrefix}-data-center`}>
                      { !isEditing && dataCenterName }
                      { isEditing &&
                        <div>
                          {dataCenterName}
                          <FieldLevelHelp disabled={false} content={msg.dataCenterChangesWithCluster()} inline />
                        </div>
                      }
                    </FieldRow>
                  </Grid>
                </Col>
                <Col className={style['fields-column']}>
                  <Grid>
                    <FieldRow label={msg.template()} id={`${idPrefix}-template`}>
                      { !isEditing && templateName }
                      { isEditing &&
                        <SelectBox
                          id={`${idPrefix}-template-edit`}
                          items={templateList}
                          selected={templateId}
                          onChange={(selectedId) => { this.handleChange('template', selectedId) }}
                        />
                      }
                    </FieldRow>
                    <FieldRow label={isEditing ? msg.changeCd() : msg.cd()} id={`${idPrefix}-cdrom`}>
                      { !isEditing && cdImageName }
                      { isEditing && !canChangeCd &&
                        <div>
                          {cdImageName}
                          <FieldLevelHelp disabled={false} content={msg.cdCanOnlyChangeWhenVmRunning()} inline />
                        </div>
                      }
                      { isEditing && canChangeCd &&
                        <SelectBox
                          id={`${idPrefix}-cd-edit`}
                          items={[
                            { id: '', value: `[${msg.empty()}]` },
                            ...isoList.map(isoFile => ({
                              id: isoFile.file.id,
                              value: isoFile.file.name,
                            })),
                          ]}
                          selected={cdImageId}
                          onChange={(selectedId) => { this.handleChange('cdrom', selectedId) }}
                        />
                      }
                    </FieldRow>
                    <FieldRow label={msg.cloudInit()} id={`${idPrefix}-cloud-init`}>
                      <div className={style['cloud-init-field']}>
                        {couldInitEnabled ? <Icon type='pf' name='on' /> : <Icon type='pf' name='off' />}
                        {enumMsg('Switch', couldInitEnabled ? 'on' : 'off')}
                      </div>
                    </FieldRow>
                    <FieldRow label={msg.bootMenu()} id={`${idPrefix}-boot-menu`}>
                      { isEditing &&
                        <Switch
                          id={`${idPrefix}-boot-menu-edit`}
                          bsSize='mini'
                          value={bootMenuEnabled}
                          onChange={(e, state) => { this.handleChange('bootMenuEnabled', state) }}
                        />
                      }
                      { !isEditing &&
                        <div className={style['boot-menu-field']}>
                          {bootMenuEnabled ? <Icon type='pf' name='on' /> : <Icon type='pf' name='off' />}
                          {enumMsg('Switch', bootMenuEnabled ? 'on' : 'off')}
                        </div>
                      }
                    </FieldRow>
                    <FieldRow label={msg.console()} id={`${idPrefix}-console`}><ConsoleList idPrefix={`${idPrefix}-console`} vm={vm} /></FieldRow>

                    <FieldRow label={msg.optimizedFor()} id={`${idPrefix}-optimized`}>
                      {optimizedFor}
                    </FieldRow>

                    <FieldRow label={msg.cpus()} id={`${idPrefix}-cpus`}>
                      { !isEditing && vCpuCount }
                      { isEditing &&
                        <div>
                          <FormControl
                            id={`${idPrefix}-cpus-edit`}
                            className={style['cpu-input']}
                            type='number'
                            value={vCpuCount}
                            onChange={e => this.handleChange('cpu', e.target.value)}
                          />
                        </div>
                      }
                    </FieldRow>
                    <FieldRow label={msg.memory()} id={`${idPrefix}-memory`}>
                      { !isEditing && `${round(memorySize)} ${memoryUnit}` }
                      { isEditing &&
                        <div>
                          <FormControl
                            id={`${idPrefix}-memory-edit`}
                            className={style['memory-input']}
                            type='number'
                            value={round(memorySize)}
                            onChange={e => this.handleChange('memory', e.target.value)}
                          />
                          {memoryUnit}
                        </div>
                      }
                    </FieldRow>
                  </Grid>
                </Col>
              </Row>
            </Grid>

            { correlatedMessages && correlatedMessages.size > 0 &&
              correlatedMessages.map((message, key) =>
                <Alert key={`user-message-${key}`} type='error' style={{ margin: '5px 0 0 0' }}>{message.get('message')}</Alert>
              )
            }
          </React.Fragment>
        }
      </BaseCard>
    </React.Fragment>
  }
}
DetailsCard.propTypes = {
  vm: PropTypes.object.isRequired,
  onEditChange: PropTypes.func,

  blankTemplateId: PropTypes.string.isRequired,
  hosts: PropTypes.object.isRequired,
  clusters: PropTypes.object.isRequired,
  dataCenters: PropTypes.object.isRequired,
  templates: PropTypes.object.isRequired,
  storageDomains: PropTypes.object.isRequired,
  userMessages: PropTypes.object.isRequired,
  operatingSystems: PropTypes.object.isRequired,

  saveChanges: PropTypes.func.isRequired,
}

const DetailsCardConnected = connect(
  (state) => ({
    blankTemplateId: state.config.get('blankTemplateId'),
    hosts: state.hosts,
    clusters: state.clusters,
    dataCenters: state.dataCenters,
    templates: state.templates,
    storageDomains: state.storageDomains,
    userMessages: state.userMessages,
    operatingSystems: state.operatingSystems,
  }),
  (dispatch) => ({
    saveChanges: (minimalVmChanges, restartAfterEdit, nextRun, correlationId) =>
      dispatch(Actions.editVm(
        { vm: minimalVmChanges, restartAfterEdit, nextRun },
        { correlationId }
      )),
  })
)(DetailsCard)

export default DetailsCardConnected
