import { createConnection } from 'net'
import { dirname } from 'path'
import { pathToFileURL } from 'url'
import { Worker } from 'worker_threads'

import lambdaLocal from 'lambda-local'

import detectNetlifyLambdaBuilder from './builders/netlify-lambda.js'
import detectZisiBuilder, { parseFunctionForMetadata } from './builders/zisi.js'
import { SECONDS_TO_MILLISECONDS } from './constants.js'

export const name = 'js'

// @ts-expect-error TS(7034) FIXME: Variable 'netlifyLambdaDetectorCache' implicitly h... Remove this comment to see the full error message
let netlifyLambdaDetectorCache

lambdaLocal.getLogger().level = 'alert'

// The netlify-lambda builder can't be enabled or disabled on a per-function
// basis and its detection mechanism is also quite expensive, so we detect
// it once and cache the result.
const detectNetlifyLambdaWithCache = () => {
  // @ts-expect-error TS(7005) FIXME: Variable 'netlifyLambdaDetectorCache' implicitly h... Remove this comment to see the full error message
  if (netlifyLambdaDetectorCache === undefined) {
    netlifyLambdaDetectorCache = detectNetlifyLambdaBuilder()
  }

  // @ts-expect-error TS(7005) FIXME: Variable 'netlifyLambdaDetectorCache' implicitly h... Remove this comment to see the full error message
  return netlifyLambdaDetectorCache
}

// @ts-expect-error TS(7031) FIXME: Binding element 'config' implicitly has an 'any' t... Remove this comment to see the full error message
export const getBuildFunction = async ({ config, directory, errorExit, func, projectRoot }) => {
  const netlifyLambdaBuilder = await detectNetlifyLambdaWithCache()

  if (netlifyLambdaBuilder) {
    return netlifyLambdaBuilder.build
  }

  const metadata = await parseFunctionForMetadata({ mainFile: func.mainFile, config, projectRoot })
  const zisiBuilder = await detectZisiBuilder({ config, directory, errorExit, func, metadata, projectRoot })

  if (zisiBuilder) {
    return zisiBuilder.build
  }

  // If there's no function builder, we create a simple one on-the-fly which
  // returns as `srcFiles` the function directory, if there is one, or its
  // main file otherwise.
  const functionDirectory = dirname(func.mainFile)
  const srcFiles = functionDirectory === directory ? [func.mainFile] : [functionDirectory]

  // @ts-expect-error TS(2532) FIXME: Object is possibly 'undefined'.
  return () => ({ schedule: metadata.schedule, srcFiles })
}

const workerURL = new URL('worker.js', import.meta.url)

// @ts-expect-error TS(7031) FIXME: Binding element 'context' implicitly has an 'any' ... Remove this comment to see the full error message
export const invokeFunction = async ({ context, environment, event, func, timeout }) => {
  if (func.buildData.runtimeAPIVersion !== 2) {
    return await invokeFunctionDirectly({ context, event, func, timeout })
  }

  const workerData = {
    clientContext: JSON.stringify(context),
    environment,
    event,
    // If a function builder has defined a `buildPath` property, we use it.
    // Otherwise, we'll invoke the function's main file.
    // Because we use import() we have to use file:// URLs for Windows.
    entryFilePath: pathToFileURL(func.buildData?.buildPath ?? func.mainFile).href,
    timeoutMs: timeout * SECONDS_TO_MILLISECONDS,
  }

  const worker = new Worker(workerURL, { workerData })
  return await new Promise((resolve, reject) => {
    worker.on('message', (result) => {
      if (result?.streamPort) {
        const client = createConnection(
          {
            port: result.streamPort,
            host: 'localhost',
          },
          () => {
            result.body = client
            resolve(result)
          },
        )
        client.on('error', reject)
      } else {
        resolve(result)
      }
    })

    worker.on('error', reject)
  })
}

// @ts-expect-error TS(7031) FIXME: Binding element 'context' implicitly has an 'any' ... Remove this comment to see the full error message
export const invokeFunctionDirectly = async ({ context, event, func, timeout }) => {
  // If a function builder has defined a `buildPath` property, we use it.
  // Otherwise, we'll invoke the function's main file.
  const lambdaPath = func.buildData?.buildPath ?? func.mainFile
  const result = await lambdaLocal.execute({
    clientContext: JSON.stringify(context),
    event,
    lambdaPath,
    timeoutMs: timeout * SECONDS_TO_MILLISECONDS,
    verboseLevel: 3,
  })

  return result
}

export const onDirectoryScan = async () => {
  const netlifyLambdaBuilder = await detectNetlifyLambdaWithCache()

  // Before we start a directory scan, we check whether netlify-lambda is being
  // used. If it is, we run it, so that the functions directory is populated
  // with the compiled files before the scan begins.
  if (netlifyLambdaBuilder) {
    await netlifyLambdaBuilder.build()
  }
}
