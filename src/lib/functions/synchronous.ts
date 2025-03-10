import { Buffer } from 'buffer'

import { isStream } from 'is-stream'

import { chalk, logPadded, NETLIFYDEVERR } from '../../utils/command-helpers.js'
import renderErrorTemplate from '../render-error-template.js'

import { detectAwsSdkError } from './utils.js'

/**
 * @typedef InvocationError
 * @property {string} errorType
 * @property {string} errorMessage
 * @property {Array<string>} stackTrace
 */

// @ts-expect-error TS(7006) FIXME: Parameter 'headers' implicitly has an 'any' type.
const addHeaders = (headers, response) => {
  if (!headers) {
    return
  }

  Object.entries(headers).forEach(([key, value]) => {
    response.setHeader(key, value)
  })
}

export const handleSynchronousFunction = function ({
  // @ts-expect-error TS(7031) FIXME: Binding element 'invocationError' implicitly has a... Remove this comment to see the full error message
  error: invocationError,
  // @ts-expect-error TS(7031) FIXME: Binding element 'functionName' implicitly has an '... Remove this comment to see the full error message
  functionName,
  // @ts-expect-error TS(7031) FIXME: Binding element 'request' implicitly has an 'any' ... Remove this comment to see the full error message
  request,
  // @ts-expect-error TS(7031) FIXME: Binding element 'response' implicitly has an 'any'... Remove this comment to see the full error message
  response,
  // @ts-expect-error TS(7031) FIXME: Binding element 'result' implicitly has an 'any' t... Remove this comment to see the full error message
  result,
}) {
  if (invocationError) {
    const error = getNormalizedError(invocationError)

    logPadded(
      `${NETLIFYDEVERR} Function ${chalk.yellow(functionName)} has returned an error: ${
        error.errorMessage
      }\n${chalk.dim(error.stackTrace.join('\n'))}`,
    )

    return handleErr(invocationError, request, response)
  }

  const { error } = validateLambdaResponse(result)
  if (error) {
    logPadded(`${NETLIFYDEVERR} ${error}`)

    return handleErr(error, request, response)
  }

  response.statusCode = result.statusCode

  try {
    addHeaders(result.headers, response)
    addHeaders(result.multiValueHeaders, response)
  } catch (headersError) {
    const normalizedError = getNormalizedError(headersError)

    logPadded(
      `${NETLIFYDEVERR} Failed to set header in function ${chalk.yellow(functionName)}: ${
        normalizedError.errorMessage
      }`,
    )

    return handleErr(headersError, request, response)
  }

  if (result.body) {
    if (isStream(result.body)) {
      result.body.pipe(response)

      return
    }

    response.write(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body)
  }
  response.end()
}

/**
 * Accepts an error generated by `lambda-local` or an instance of `Error` and
 * returns a normalized error that we can treat in the same way.
 *
 * @param {InvocationError|Error} error
 * @returns {InvocationError}
 */
// @ts-expect-error TS(7006) FIXME: Parameter 'error' implicitly has an 'any' type.
const getNormalizedError = (error) => {
  if (error instanceof Error) {
    const normalizedError = {
      errorMessage: error.message,
      errorType: error.name,
      stackTrace: error.stack ? error.stack.split('\n') : [],
    }

    if ('code' in error && error.code === 'ERR_REQUIRE_ESM') {
      return {
        ...normalizedError,
        errorMessage:
          'a CommonJS file cannot import ES modules. Consider switching your function to ES modules. For more information, refer to https://ntl.fyi/functions-runtime.',
      }
    }

    return normalizedError
  }

  // Formatting stack trace lines in the same way that Node.js formats native
  // errors.
  // @ts-expect-error TS(7006) FIXME: Parameter 'line' implicitly has an 'any' type.
  const stackTrace = error.stackTrace.map((line) => `    at ${line}`)

  return {
    errorType: error.errorType,
    errorMessage: error.errorMessage,
    stackTrace,
  }
}

// @ts-expect-error TS(7006) FIXME: Parameter 'rawError' implicitly has an 'any' type.
const formatLambdaLocalError = (rawError, acceptsHTML) => {
  const error = getNormalizedError(rawError)

  if (acceptsHTML) {
    return JSON.stringify({
      ...error,
      stackTrace: undefined,
      trace: error.stackTrace,
    })
  }

  return `${error.errorType}: ${error.errorMessage}\n ${error.stackTrace.join('\n')}`
}

// @ts-expect-error TS(7006) FIXME: Parameter 'err' implicitly has an 'any' type.
const handleErr = async (err, request, response) => {
  // @ts-expect-error TS(2345) FIXME: Argument of type '{ err: any; }' is not assignable... Remove this comment to see the full error message
  detectAwsSdkError({ err })

  const acceptsHtml = request.headers && request.headers.accept && request.headers.accept.includes('text/html')
  const errorString = typeof err === 'string' ? err : formatLambdaLocalError(err, acceptsHtml)

  response.statusCode = 500

  if (acceptsHtml) {
    response.setHeader('Content-Type', 'text/html')
    response.end(await renderErrorTemplate(errorString, './templates/function-error.html', 'function'))
  } else {
    response.end(errorString)
  }
}

// @ts-expect-error TS(7006) FIXME: Parameter 'lambdaResponse' implicitly has an 'any'... Remove this comment to see the full error message
const validateLambdaResponse = (lambdaResponse) => {
  if (lambdaResponse === undefined) {
    return { error: 'lambda response was undefined. check your function code again' }
  }
  if (lambdaResponse === null) {
    return {
      error: 'no lambda response. check your function code again. make sure to return a promise or use the callback.',
    }
  }
  if (!Number(lambdaResponse.statusCode)) {
    return {
      error: `Your function response must have a numerical statusCode. You gave: ${lambdaResponse.statusCode}`,
    }
  }
  if (lambdaResponse.body && typeof lambdaResponse.body !== 'string' && !isStream(lambdaResponse.body)) {
    return { error: `Your function response must have a string or a stream body. You gave: ${lambdaResponse.body}` }
  }

  return {}
}
