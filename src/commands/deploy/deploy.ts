import { stat } from 'fs/promises'
import { basename, resolve } from 'path'

import { runCoreSteps } from '@netlify/build'
import { OptionValues } from 'commander'
import inquirer from 'inquirer'
import isEmpty from 'lodash/isEmpty.js'
import isObject from 'lodash/isObject.js'
import { parseAllHeaders } from 'netlify-headers-parser'
import { parseAllRedirects } from 'netlify-redirect-parser'
import prettyjson from 'prettyjson'

import { cancelDeploy } from '../../lib/api.js'
import { getBuildOptions, runBuild } from '../../lib/build.js'
import { getBootstrapURL } from '../../lib/edge-functions/bootstrap.js'
import { featureFlags as edgeFunctionsFeatureFlags } from '../../lib/edge-functions/consts.js'
import { normalizeFunctionsConfig } from '../../lib/functions/config.js'
import { BACKGROUND_FUNCTIONS_WARNING } from '../../lib/log.js'
import { startSpinner, stopSpinner } from '../../lib/spinner.js'
import {
  chalk,
  error,
  exit,
  getToken,
  log,
  logJson,
  NETLIFYDEV,
  NETLIFYDEVERR,
  NETLIFYDEVLOG,
  warn,
} from '../../utils/command-helpers.js'
import { DEFAULT_DEPLOY_TIMEOUT } from '../../utils/deploy/constants.js'
import { deploySite } from '../../utils/deploy/deploy-site.js'
import { getEnvelopeEnv } from '../../utils/env/index.js'
import { getFunctionsManifestPath, getInternalFunctionsDir } from '../../utils/functions/index.js'
import openBrowser from '../../utils/open-browser.js'
import BaseCommand from '../base-command.js'
import { link } from '../link/link.js'
import { sitesCreate } from '../sites/sites-create.js'

// @ts-expect-error TS(7031) FIXME: Binding element 'api' implicitly has an 'any' type... Remove this comment to see the full error message
const triggerDeploy = async ({ api, options, siteData, siteId }) => {
  try {
    const siteBuild = await api.createSiteBuild({ siteId })
    if (options.json) {
      logJson({
        site_id: siteId,
        site_name: siteData.name,
        deploy_id: `${siteBuild.deploy_id}`,
        logs: `https://app.netlify.com/sites/${siteData.name}/deploys/${siteBuild.deploy_id}`,
      })
    } else {
      log(
        `${NETLIFYDEV} A new deployment was triggered successfully. Visit https://app.netlify.com/sites/${siteData.name}/deploys/${siteBuild.deploy_id} to see the logs.`,
      )
    }
  } catch (error_) {
    // @ts-expect-error TS(2571) FIXME: Object is of type 'unknown'.
    if (error_.status === 404) {
      error('Site not found. Please rerun "netlify link" and make sure that your site has CI configured.')
    } else {
      // @ts-expect-error TS(2571) FIXME: Object is of type 'unknown'.
      error(error_.message)
    }
  }
}

/**
 * Retrieves the folder containing the static files that need to be deployed
 * @param {object} config
 * @param {import('../base-command.js').default} config.command The process working directory
 * @param {object} config.config
 * @param {import('commander').OptionValues} config.options
 * @param {object} config.site
 * @param {object} config.siteData
 * @returns {Promise<string>}
 */
// @ts-expect-error TS(7031) FIXME: Binding element 'command' implicitly has an 'any' ... Remove this comment to see the full error message
const getDeployFolder = async ({ command, config, options, site, siteData }) => {
  let deployFolder
  // if the `--dir .` flag is provided we should resolve it to the working directory.
  // - in regular sites this is the `process.cwd`
  // - in mono repositories this will be the root of the jsWorkspace
  if (options.dir) {
    deployFolder = command.workspacePackage
      ? resolve(command.jsWorkspaceRoot || site.root, options.dir)
      : resolve(command.workingDir, options.dir)
  } else if (config?.build?.publish) {
    deployFolder = resolve(site.root, config.build.publish)
  } else if (siteData?.build_settings?.dir) {
    deployFolder = resolve(site.root, siteData.build_settings.dir)
  }

  if (!deployFolder) {
    log('Please provide a publish directory (e.g. "public" or "dist" or "."):')
    const { promptPath } = await inquirer.prompt([
      {
        type: 'input',
        name: 'promptPath',
        message: 'Publish directory',
        default: '.',
        filter: (input) => resolve(command.workingDir, input),
      },
    ])
    deployFolder = promptPath
  }

  return deployFolder
}

/**
 * @param {string} deployFolder
 */
// @ts-expect-error TS(7006) FIXME: Parameter 'deployFolder' implicitly has an 'any' t... Remove this comment to see the full error message
const validateDeployFolder = async (deployFolder) => {
  /** @type {import('fs').Stats} */
  let stats
  try {
    stats = await stat(deployFolder)
  } catch (error_) {
    // @ts-expect-error TS(2571) FIXME: Object is of type 'unknown'.
    if (error_.code === 'ENOENT') {
      return error(`No such directory ${deployFolder}! Did you forget to run a build?`)
    }

    // Improve the message of permission errors
    // @ts-expect-error TS(2571) FIXME: Object is of type 'unknown'.
    if (error_.code === 'EACCES') {
      return error('Permission error when trying to access deploy folder')
    }
    throw error_
  }

  if (!stats.isDirectory()) {
    return error('Deploy target must be a path to a directory')
  }
  return stats
}

/**
 * get the functions directory
 * @param {object} config
 * @param {object} config.config
 * @param {import('commander').OptionValues} config.options
 * @param {object} config.site
 * @param {object} config.siteData
 * @param {string} config.workingDir // The process working directory
 * @returns {string|undefined}
 */
// @ts-expect-error TS(7031) FIXME: Binding element 'config' implicitly has an 'any' t... Remove this comment to see the full error message
const getFunctionsFolder = ({ config, options, site, siteData, workingDir }) => {
  let functionsFolder
  // Support "functions" and "Functions"
  const funcConfig = config.functionsDirectory
  if (options.functions) {
    functionsFolder = resolve(workingDir, options.functions)
  } else if (funcConfig) {
    functionsFolder = resolve(site.root, funcConfig)
  } else if (siteData?.build_settings?.functions_dir) {
    functionsFolder = resolve(site.root, siteData.build_settings.functions_dir)
  }
  return functionsFolder
}

/**
 *
 * @param {string|undefined} functionsFolder
 */
// @ts-expect-error TS(7006) FIXME: Parameter 'functionsFolder' implicitly has an 'any... Remove this comment to see the full error message
const validateFunctionsFolder = async (functionsFolder) => {
  /** @type {import('fs').Stats|undefined} */
  let stats
  if (functionsFolder) {
    // we used to hard error if functions folder is specified but doesn't exist
    // but this was too strict for onboarding. we can just log a warning.
    try {
      stats = await stat(functionsFolder)
    } catch (error_) {
      // @ts-expect-error TS(2571) FIXME: Object is of type 'unknown'.
      if (error_.code === 'ENOENT') {
        log(
          `Functions folder "${functionsFolder}" specified but it doesn't exist! Will proceed without deploying functions`,
        )
      }
      // Improve the message of permission errors
      // @ts-expect-error TS(2571) FIXME: Object is of type 'unknown'.
      if (error_.code === 'EACCES') {
        error('Permission error when trying to access functions folder')
      }
    }
  }

  if (stats && !stats.isDirectory()) {
    error('Functions folder must be a path to a directory')
  }

  return stats
}

// @ts-expect-error TS(7031) FIXME: Binding element 'deployFolder' implicitly has an '... Remove this comment to see the full error message
const validateFolders = async ({ deployFolder, functionsFolder }) => {
  const deployFolderStat = await validateDeployFolder(deployFolder)
  const functionsFolderStat = await validateFunctionsFolder(functionsFolder)
  return { deployFolderStat, functionsFolderStat }
}

/**
 * @param {object} config
 * @param {string} config.deployFolder
 * @param {*} config.site
 * @returns
 */
// @ts-expect-error TS(7031) FIXME: Binding element 'deployFolder' implicitly has an '... Remove this comment to see the full error message
const getDeployFilesFilter = ({ deployFolder, site }) => {
  // site.root === deployFolder can happen when users run `netlify deploy --dir .`
  // in that specific case we don't want to publish the repo node_modules
  // when site.root !== deployFolder the behaviour matches our buildbot
  const skipNodeModules = site.root === deployFolder

  /**
   * @param {string} filename
   */
  // @ts-expect-error TS(7006) FIXME: Parameter 'filename' implicitly has an 'any' type.
  return (filename) => {
    if (filename == null) {
      return false
    }
    if (filename === deployFolder) {
      return true
    }

    const base = basename(filename)
    const skipFile =
      (skipNodeModules && base === 'node_modules') ||
      (base.startsWith('.') && base !== '.well-known') ||
      base.startsWith('__MACOSX') ||
      base.includes('/.') ||
      // headers and redirects are bundled in the config
      base === '_redirects' ||
      base === '_headers'

    return !skipFile
  }
}

const SEC_TO_MILLISEC = 1e3
// 100 bytes
const SYNC_FILE_LIMIT = 1e2

// @ts-expect-error TS(7031) FIXME: Binding element 'api' implicitly has an 'any' type... Remove this comment to see the full error message
const prepareProductionDeploy = async ({ api, siteData }) => {
  if (isObject(siteData.published_deploy) && siteData.published_deploy.locked) {
    log(`\n${NETLIFYDEVERR} Deployments are "locked" for production context of this site\n`)
    const { unlockChoice } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'unlockChoice',
        message: 'Would you like to "unlock" deployments for production context to proceed?',
        default: false,
      },
    ])
    if (!unlockChoice) exit(0)
    await api.unlockDeploy({ deploy_id: siteData.published_deploy.id })
    log(`\n${NETLIFYDEVLOG} "Auto publishing" has been enabled for production context\n`)
  }
  log('Deploying to main site URL...')
}

// @ts-expect-error TS(7006) FIXME: Parameter 'actual' implicitly has an 'any' type.
const hasErrorMessage = (actual, expected) => {
  if (typeof actual === 'string') {
    return actual.includes(expected)
  }
  return false
}

// @ts-expect-error TS(7031) FIXME: Binding element 'error_' implicitly has an 'any' t... Remove this comment to see the full error message
const reportDeployError = ({ error_, failAndExit }) => {
  switch (true) {
    case error_.name === 'JSONHTTPError': {
      const message = error_?.json?.message ?? ''
      if (hasErrorMessage(message, 'Background Functions not allowed by team plan')) {
        return failAndExit(`\n${BACKGROUND_FUNCTIONS_WARNING}`)
      }
      warn(`JSONHTTPError: ${message} ${error_.status}`)
      warn(`\n${JSON.stringify(error_, null, '  ')}\n`)
      failAndExit(error_)
      return
    }
    case error_.name === 'TextHTTPError': {
      warn(`TextHTTPError: ${error_.status}`)
      warn(`\n${error_}\n`)
      failAndExit(error_)
      return
    }
    case hasErrorMessage(error_.message, 'Invalid filename'): {
      warn(error_.message)
      failAndExit(error_)
      return
    }
    default: {
      warn(`\n${JSON.stringify(error_, null, '  ')}\n`)
      failAndExit(error_)
    }
  }
}

const deployProgressCb = function () {
  /**
   * @type {Record<string, import('ora').Ora>}
   */
  const events = {}
  // @ts-expect-error TS(7006) FIXME: Parameter 'event' implicitly has an 'any' type.
  return (event) => {
    switch (event.phase) {
      case 'start': {
        // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
        events[event.type] = startSpinner({
          text: event.msg,
        })
        return
      }
      case 'progress': {
        // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
        const spinner = events[event.type]
        if (spinner) {
          spinner.text = event.msg
        }
        return
      }
      case 'error':
        // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
        stopSpinner({ error: true, spinner: events[event.type], text: event.msg })
        // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
        delete events[event.type]
        return
      case 'stop':
      default: {
        // @ts-expect-error TS(2345) FIXME: Argument of type '{ spinner: any; text: any; }' is... Remove this comment to see the full error message
        stopSpinner({ spinner: events[event.type], text: event.msg })
        // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
        delete events[event.type]
      }
    }
  }
}

const runDeploy = async ({
  // @ts-expect-error TS(7031) FIXME: Binding element 'alias' implicitly has an 'any' ty... Remove this comment to see the full error message
  alias,
  // @ts-expect-error TS(7031) FIXME: Binding element 'api' implicitly has an 'any' type... Remove this comment to see the full error message
  api,
  // @ts-expect-error TS(7031) FIXME: Binding element 'command' implicitly has an 'any' ... Remove this comment to see the full error message
  command,
  // @ts-expect-error TS(7031) FIXME: Binding element 'config' implicitly has an 'any' t... Remove this comment to see the full error message
  config,
  // @ts-expect-error TS(7031) FIXME: Binding element 'deployFolder' implicitly has an '... Remove this comment to see the full error message
  deployFolder,
  // @ts-expect-error TS(7031) FIXME: Binding element 'deployTimeout' implicitly has an ... Remove this comment to see the full error message
  deployTimeout,
  // @ts-expect-error TS(7031) FIXME: Binding element 'deployToProduction' implicitly ha... Remove this comment to see the full error message
  deployToProduction,
  // @ts-expect-error TS(7031) FIXME: Binding element 'functionsConfig' implicitly has a... Remove this comment to see the full error message
  functionsConfig,
  // @ts-expect-error TS(7031) FIXME: Binding element 'functionsFolder' implicitly has a... Remove this comment to see the full error message
  functionsFolder,
  // @ts-expect-error TS(7031) FIXME: Binding element 'packagePath' implicitly has an 'a... Remove this comment to see the full error message
  packagePath,
  // @ts-expect-error TS(7031) FIXME: Binding element 'silent' implicitly has an 'any' t... Remove this comment to see the full error message
  silent,
  // @ts-expect-error TS(7031) FIXME: Binding element 'site' implicitly has an 'any' typ... Remove this comment to see the full error message
  site,
  // @ts-expect-error TS(7031) FIXME: Binding element 'siteData' implicitly has an 'any'... Remove this comment to see the full error message
  siteData,
  // @ts-expect-error TS(7031) FIXME: Binding element 'siteId' implicitly has an 'any' t... Remove this comment to see the full error message
  siteId,
  // @ts-expect-error TS(7031) FIXME: Binding element 'skipFunctionsCache' implicitly ha... Remove this comment to see the full error message
  skipFunctionsCache,
  // @ts-expect-error TS(7031) FIXME: Binding element 'title' implicitly has an 'any' ty... Remove this comment to see the full error message
  title,
}) => {
  let results
  let deployId

  try {
    if (deployToProduction) {
      await prepareProductionDeploy({ siteData, api })
    } else {
      log('Deploying to draft URL...')
    }

    const draft = !deployToProduction && !alias
    results = await api.createSiteDeploy({ siteId, title, body: { draft, branch: alias } })
    deployId = results.id

    // @ts-expect-error TS(2345) FIXME: Argument of type '{ base: any; packagePath: any; }... Remove this comment to see the full error message
    const internalFunctionsFolder = await getInternalFunctionsDir({ base: site.root, packagePath })

    // The order of the directories matter: zip-it-and-ship-it will prioritize
    // functions from the rightmost directories. In this case, we want user
    // functions to take precedence over internal functions.
    const functionDirectories = [internalFunctionsFolder, functionsFolder].filter(Boolean)
    const manifestPath = skipFunctionsCache ? null : await getFunctionsManifestPath({ base: site.root, packagePath })

    const redirectsPath = `${deployFolder}/_redirects`
    const headersPath = `${deployFolder}/_headers`

    const { redirects } = await parseAllRedirects({
      configRedirects: config.redirects,
      redirectsFiles: [redirectsPath],
      minimal: true,
    })

    config.redirects = redirects

    const { headers } = await parseAllHeaders({
      configHeaders: config.headers,
      // @ts-expect-error TS(2322) FIXME: Type 'string' is not assignable to type 'never'.
      headersFiles: [headersPath],
      minimal: true,
    })

    config.headers = headers

    results = await deploySite(api, siteId, deployFolder, {
      config,
      // @ts-expect-error TS(2322) FIXME: Type 'any[]' is not assignable to type 'never[]'.
      fnDir: functionDirectories,
      functionsConfig,
      // @ts-expect-error TS(2322) FIXME: Type '(event: any) => void' is not assignable to t... Remove this comment to see the full error message
      statusCb: silent ? () => {} : deployProgressCb(),
      deployTimeout,
      syncFileLimit: SYNC_FILE_LIMIT,
      // pass an existing deployId to update
      deployId,
      filter: getDeployFilesFilter({ site, deployFolder }),
      workingDir: command.workingDir,
      manifestPath,
      skipFunctionsCache,
      siteRoot: site.root,
    })
  } catch (error_) {
    if (deployId) {
      await cancelDeploy({ api, deployId })
    }
    reportDeployError({ error_, failAndExit: error })
  }

  const siteUrl = results.deploy.ssl_url || results.deploy.url
  const deployUrl = results.deploy.deploy_ssl_url || results.deploy.deploy_url
  const logsUrl = `${results.deploy.admin_url}/deploys/${results.deploy.id}`

  let functionLogsUrl = `${results.deploy.admin_url}/functions`

  if (!deployToProduction) {
    functionLogsUrl += `?scope=deploy:${deployId}`
  }

  return {
    siteId: results.deploy.site_id,
    siteName: results.deploy.name,
    deployId: results.deployId,
    siteUrl,
    deployUrl,
    logsUrl,
    functionLogsUrl,
  }
}

/**
 *
 * @param {object} config
 * @param {*} config.cachedConfig
 * @param {string} [config.packagePath]
 * @param {*} config.deployHandler
 * @param {string} config.currentDir
 * @param {import('commander').OptionValues} config.options The options of the command
 * @returns
 */
// @ts-expect-error TS(7031) FIXME: Binding element 'cachedConfig' implicitly has an '... Remove this comment to see the full error message
const handleBuild = async ({ cachedConfig, currentDir, deployHandler, options, packagePath }) => {
  if (!options.build) {
    return {}
  }
  // @ts-expect-error TS(2554) FIXME: Expected 1 arguments, but got 0.
  const [token] = await getToken()
  const resolvedOptions = await getBuildOptions({
    cachedConfig,
    packagePath,
    token,
    options,
    currentDir,
    deployHandler,
  })
  const { configMutations, exitCode, newConfig } = await runBuild(resolvedOptions)
  if (exitCode !== 0) {
    exit(exitCode)
  }
  return { newConfig, configMutations }
}

/**
 *
 * @param {*} options Bundling options
 * @param {import('..//base-command.js').default} command
 * @returns
 */
// @ts-expect-error TS(7006) FIXME: Parameter 'options' implicitly has an 'any' type.
const bundleEdgeFunctions = async (options, command) => {
  // eslint-disable-next-line n/prefer-global/process, unicorn/prefer-set-has
  const argv = process.argv.slice(2)
  const statusCb =
    options.silent || argv.includes('--json') || argv.includes('--silent') ? () => {} : deployProgressCb()

  statusCb({
    type: 'edge-functions-bundling',
    msg: 'Bundling edge functions...\n',
    phase: 'start',
  })

  const { severityCode, success } = await runCoreSteps(['edge_functions_bundling'], {
    ...options,
    packagePath: command.workspacePackage,
    buffer: true,
    featureFlags: edgeFunctionsFeatureFlags,
    edgeFunctionsBootstrapURL: getBootstrapURL(),
  })

  if (!success) {
    statusCb({
      type: 'edge-functions-bundling',
      msg: 'Deploy aborted due to error while bundling edge functions',
      phase: 'error',
    })

    exit(severityCode)
  }

  statusCb({
    type: 'edge-functions-bundling',
    msg: 'Finished bundling edge functions',
    phase: 'stop',
  })
}

/**
 *
 * @param {object} config
 * @param {boolean} config.deployToProduction
 * @param {boolean} config.isIntegrationDeploy If the user ran netlify integration:deploy instead of just netlify deploy
 * @param {boolean} config.json If the result should be printed as json message
 * @param {boolean} config.runBuildCommand If the build command should be run
 * @param {object} config.results
 * @returns {void}
 */
// @ts-expect-error TS(7031) FIXME: Binding element 'deployToProduction' implicitly ha... Remove this comment to see the full error message
const printResults = ({ deployToProduction, isIntegrationDeploy, json, results, runBuildCommand }) => {
  const msgData = {
    'Build logs': results.logsUrl,
    'Function logs': results.functionLogsUrl,
  }

  if (deployToProduction) {
    // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
    msgData['Unique deploy URL'] = results.deployUrl
    // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
    msgData['Website URL'] = results.siteUrl
  } else {
    // @ts-expect-error TS(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
    msgData['Website draft URL'] = results.deployUrl
  }

  // Spacer
  log()

  // Json response for piping commands
  if (json) {
    const jsonData = {
      name: results.name,
      site_id: results.site_id,
      site_name: results.siteName,
      deploy_id: results.deployId,
      deploy_url: results.deployUrl,
      logs: results.logsUrl,
    }
    if (deployToProduction) {
      // @ts-expect-error TS(2339) FIXME: Property 'url' does not exist on type '{ name: any... Remove this comment to see the full error message
      jsonData.url = results.siteUrl
    }

    logJson(jsonData)
    exit(0)
  } else {
    log(prettyjson.render(msgData))

    if (!deployToProduction) {
      log()
      log('If everything looks good on your draft URL, deploy it to your main site URL with the --prod flag.')
      log(
        `${chalk.cyanBright.bold(
          `netlify ${isIntegrationDeploy ? 'integration:' : ''}deploy${runBuildCommand ? ' --build' : ''} --prod`,
        )}`,
      )
      log()
    }
  }
}

const prepAndRunDeploy = async ({
  // @ts-expect-error TS(7031) FIXME: Binding element 'api' implicitly has an 'any' type... Remove this comment to see the full error message
  api,
  // @ts-expect-error TS(7031) FIXME: Binding element 'command' implicitly has an 'any' ... Remove this comment to see the full error message
  command,
  // @ts-expect-error TS(7031) FIXME: Binding element 'config' implicitly has an 'any' t... Remove this comment to see the full error message
  config,
  // @ts-expect-error TS(7031) FIXME: Binding element 'deployToProduction' implicitly ha... Remove this comment to see the full error message
  deployToProduction,
  // @ts-expect-error TS(7031) FIXME: Binding element 'options' implicitly has an 'any' ... Remove this comment to see the full error message
  options,
  // @ts-expect-error TS(7031) FIXME: Binding element 'site' implicitly has an 'any' typ... Remove this comment to see the full error message
  site,
  // @ts-expect-error TS(7031) FIXME: Binding element 'siteData' implicitly has an 'any'... Remove this comment to see the full error message
  siteData,
  // @ts-expect-error TS(7031) FIXME: Binding element 'siteId' implicitly has an 'any' t... Remove this comment to see the full error message
  siteId,
  // @ts-expect-error TS(7031) FIXME: Binding element 'workingDir' implicitly has an 'an... Remove this comment to see the full error message
  workingDir,
}) => {
  const alias = options.alias || options.branch
  const isUsingEnvelope = siteData && siteData.use_envelope
  // if a context is passed besides dev, we need to pull env vars from that specific context
  if (isUsingEnvelope && options.context && options.context !== 'dev') {
    command.netlify.cachedConfig.env = await getEnvelopeEnv({
      api,
      context: options.context,
      env: command.netlify.cachedConfig.env,
      siteInfo: siteData,
    })
  }

  const deployFolder = await getDeployFolder({ command, options, config, site, siteData })
  const functionsFolder = getFunctionsFolder({ workingDir, options, config, site, siteData })
  const { configPath } = site

  const edgeFunctionsConfig = command.netlify.config.edge_functions

  // build flag wasn't used and edge functions exist
  if (!options.build && edgeFunctionsConfig && edgeFunctionsConfig.length !== 0) {
    await bundleEdgeFunctions(options, command)
  }

  log(
    prettyjson.render({
      'Deploy path': deployFolder,
      'Functions path': functionsFolder,
      'Configuration path': configPath,
    }),
  )

  const { functionsFolderStat } = await validateFolders({
    deployFolder,
    functionsFolder,
  })

  const siteEnv = isUsingEnvelope
    ? await getEnvelopeEnv({
        api,
        context: options.context,
        env: command.netlify.cachedConfig.env,
        raw: true,
        scope: 'functions',
        siteInfo: siteData,
      })
    : siteData?.build_settings?.env

  const functionsConfig = normalizeFunctionsConfig({
    functionsConfig: config.functions,
    projectRoot: site.root,
    siteEnv,
  })

  const results = await runDeploy({
    alias,
    api,
    command,
    config,
    deployFolder,
    deployTimeout: options.timeout * SEC_TO_MILLISEC || DEFAULT_DEPLOY_TIMEOUT,
    deployToProduction,
    functionsConfig,
    // pass undefined functionsFolder if doesn't exist
    functionsFolder: functionsFolderStat && functionsFolder,
    packagePath: command.workspacePackage,
    silent: options.json || options.silent,
    site,
    siteData,
    siteId,
    skipFunctionsCache: options.skipFunctionsCache,
    title: options.message,
  })

  return results
}

export const deploy = async (options: OptionValues, command: BaseCommand) => {
  const { workingDir } = command
  const { api, site, siteInfo } = command.netlify
  const alias = options.alias || options.branch

  command.setAnalyticsPayload({ open: options.open, prod: options.prod, json: options.json, alias: Boolean(alias) })

  if (options.branch) {
    warn('--branch flag has been renamed to --alias and will be removed in future versions')
  }

  if (options.context && !options.build) {
    return error('--context flag is only available when using the --build flag')
  }

  await command.authenticate(options.auth)

  let siteId = site.id || options.site

  let siteData = {}
  if (siteId && !isEmpty(siteInfo)) {
    siteData = siteInfo
    // @ts-expect-error TS(2339) FIXME: Property 'id' does not exist on type '{}'.
    siteId = siteData.id
  } else {
    log("This folder isn't linked to a site yet")
    const NEW_SITE = '+  Create & configure a new site'
    const EXISTING_SITE = 'Link this directory to an existing site'

    const initializeOpts = [EXISTING_SITE, NEW_SITE]

    const { initChoice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'initChoice',
        message: 'What would you like to do?',
        choices: initializeOpts,
      },
    ])
    // create site or search for one
    if (initChoice === NEW_SITE) {
      // @ts-expect-error TS(2322) FIXME: Type 'undefined' is not assignable to type '{}'.
      siteData = await sitesCreate({}, command)
      // @ts-expect-error TS(2339) FIXME: Property 'id' does not exist on type '{}'.
      site.id = siteData.id
      siteId = site.id
    } else if (initChoice === EXISTING_SITE) {
      siteData = await link({}, command)
      // @ts-expect-error TS(2339) FIXME: Property 'id' does not exist on type '{}'.
      site.id = siteData.id
      siteId = site.id
    }
  }

  if (options.trigger) {
    return triggerDeploy({ api, options, siteData, siteId })
  }

  // @ts-expect-error TS(2339) FIXME: Property 'published_deploy' does not exist on type... Remove this comment to see the full error message
  const deployToProduction = options.prod || (options.prodIfUnlocked && !siteData.published_deploy.locked)

  let results = {}

  if (options.build) {
    await handleBuild({
      packagePath: command.workspacePackage,
      cachedConfig: command.netlify.cachedConfig,
      currentDir: command.workingDir,
      options,
      // @ts-expect-error TS(7031) FIXME: Binding element 'netlifyConfig' implicitly has an ... Remove this comment to see the full error message
      deployHandler: async ({ netlifyConfig }) => {
        results = await prepAndRunDeploy({
          command,
          options,
          workingDir,
          api,
          site,
          config: netlifyConfig,
          siteData,
          siteId,
          deployToProduction,
        })

        return {}
      },
    })
  } else {
    results = await prepAndRunDeploy({
      command,
      options,
      workingDir,
      api,
      site,
      config: command.netlify.config,
      siteData,
      siteId,
      deployToProduction,
    })
  }
  const isIntegrationDeploy = command.name() === 'integration:deploy'

  printResults({
    runBuildCommand: options.build,
    isIntegrationDeploy,
    json: options.json,
    results,
    deployToProduction,
  })

  if (options.open) {
    // @ts-expect-error TS(2339) FIXME: Property 'siteUrl' does not exist on type '{}'.
    const urlToOpen = deployToProduction ? results.siteUrl : results.deployUrl
    // @ts-expect-error TS(2345) FIXME: Argument of type '{ url: any; }' is not assignable... Remove this comment to see the full error message
    await openBrowser({ url: urlToOpen })
    exit()
  }
}
