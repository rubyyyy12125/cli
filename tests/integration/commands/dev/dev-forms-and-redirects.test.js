// Handlers are meant to be async outside tests
import fs from 'fs/promises'
import path from 'path'

import FormData from 'form-data'
import getPort from 'get-port'
import fetch from 'node-fetch'
import { describe, test } from 'vitest'

import { withDevServer } from '../../utils/dev-server.ts'
import { withSiteBuilder } from '../../utils/site-builder.ts'

describe.concurrent('commands/dev-forms-and-redirects', () => {
  test('should return 404 when redirecting to a non existing function', async (t) => {
    await withSiteBuilder('site-with-missing-function', async (builder) => {
      builder.withNetlifyToml({
        config: {
          functions: { directory: 'functions' },
          redirects: [{ from: '/api/*', to: '/.netlify/functions/:splat', status: 200 }],
        },
      })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const response = await fetch(`${server.url}/api/none`, {
          method: 'POST',
          body: 'nothing',
        })

        t.expect(response.status).toBe(404)
      })
    })
  })

  test('should parse function query parameters using simple parsing', async (t) => {
    await withSiteBuilder('site-with-multi-part-function', async (builder) => {
      builder
        .withNetlifyToml({
          config: {
            functions: { directory: 'functions' },
          },
        })
        .withFunction({
          path: 'echo.js',
          handler: async (event) => ({
            statusCode: 200,
            body: JSON.stringify(event),
          }),
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const [response1, response2] = await Promise.all([
          fetch(`${server.url}/.netlify/functions/echo?category[SOMETHING][]=something`).then((res) => res.json()),
          fetch(`${server.url}/.netlify/functions/echo?category=one&category=two`).then((res) => res.json()),
        ])

        t.expect(response1.queryStringParameters).toStrictEqual({ 'category[SOMETHING][]': 'something' })
        t.expect(response2.queryStringParameters).toStrictEqual({ category: 'one, two' })
      })
    })
  })

  test('should handle form submission', async (t) => {
    await withSiteBuilder('site-with-form', async (builder) => {
      builder
        .withContentFile({
          path: 'index.html',
          content: '<h1>⊂◉‿◉つ</h1>',
        })
        .withNetlifyToml({
          config: {
            functions: { directory: 'functions' },
          },
        })
        .withFunction({
          path: 'submission-created.js',
          handler: async (event) => ({
            statusCode: 200,
            body: JSON.stringify(event),
          }),
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const form = new FormData()
        form.append('some', 'thing')
        const response = await fetch(`${server.url}/?ding=dong`, {
          method: 'POST',
          body: form,
        }).then((res) => res.json())

        const body = JSON.parse(response.body)
        const expectedBody = {
          payload: {
            created_at: body.payload.created_at,
            data: {
              ip: '::ffff:127.0.0.1',
              some: 'thing',
              user_agent: 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
            },
            human_fields: {
              Some: 'thing',
            },
            ordered_human_fields: [
              {
                name: 'some',
                title: 'Some',
                value: 'thing',
              },
            ],
            site_url: '',
          },
        }

        t.expect(response.headers.host).toEqual(`${server.host}:${server.port}`)
        t.expect(response.headers['content-length']).toEqual(JSON.stringify(expectedBody).length.toString())
        t.expect(response.headers['content-type']).toEqual('application/json')
        t.expect(response.httpMethod).toEqual('POST')
        t.expect(response.isBase64Encoded).toBe(false)
        t.expect(response.path).toEqual('/')
        t.expect(response.queryStringParameters).toStrictEqual({ ding: 'dong' })
        t.expect(body).toStrictEqual(expectedBody)
      })
    })
  })

  test('should handle form submission with a background function', async (t) => {
    await withSiteBuilder('site-with-form-background-function', async (builder) => {
      await builder
        .withContentFile({
          path: 'index.html',
          content: '<h1>⊂◉‿◉つ</h1>',
        })
        .withNetlifyToml({
          config: {
            functions: { directory: 'functions' },
          },
        })
        .withFunction({
          path: 'submission-created-background.js',
          handler: async (event) => ({
            statusCode: 200,
            body: JSON.stringify(event),
          }),
        })
        .buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const form = new FormData()
        form.append('some', 'thing')
        const response = await fetch(`${server.url}/?ding=dong`, {
          method: 'POST',
          body: form,
        })
        t.expect(response.status).toBe(202)
        t.expect(await response.text()).toEqual('')
      })
    })
  })

  test('should not handle form submission when content type is `text/plain`', async (t) => {
    await withSiteBuilder('site-with-form-text-plain', async (builder) => {
      builder
        .withContentFile({
          path: 'index.html',
          content: '<h1>⊂◉‿◉つ</h1>',
        })
        .withNetlifyToml({
          config: {
            functions: { directory: 'functions' },
          },
        })
        .withFunction({
          path: 'submission-created.js',
          handler: async (event) => ({
            statusCode: 200,
            body: JSON.stringify(event),
          }),
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const response = await fetch(`${server.url}/?ding=dong`, {
          method: 'POST',
          body: 'Something',
          headers: {
            'content-type': 'text/plain',
          },
        })
        t.expect(response.status).toBe(405)
        t.expect(await response.text()).toEqual('Method Not Allowed')
      })
    })
  })

  test('should return existing local file even when rewrite matches when force=false', async (t) => {
    await withSiteBuilder('site-with-shadowing-force-false', async (builder) => {
      builder
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })
        .withContentFile({
          path: path.join('not-foo', 'index.html'),
          content: '<html><h1>not-foo',
        })
        .withNetlifyToml({
          config: {
            redirects: [{ from: '/foo', to: '/not-foo', status: 200, force: false }],
          },
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const response = await fetch(`${server.url}/foo?ping=pong`).then((res) => res.text())
        t.expect(response).toEqual('<html><h1>foo')
      })
    })
  })

  test('should return existing local file even when redirect matches when force=false', async (t) => {
    await withSiteBuilder('site-with-shadowing-force-false', async (builder) => {
      builder
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })
        .withContentFile({
          path: path.join('not-foo', 'index.html'),
          content: '<html><h1>not-foo',
        })
        .withNetlifyToml({
          config: {
            redirects: [{ from: '/foo', to: '/not-foo', status: 301, force: false }],
          },
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const response = await fetch(`${server.url}/foo?ping=pong`).then((res) => res.text())
        t.expect(response).toEqual('<html><h1>foo')
      })
    })
  })

  test('should ignore existing local file when redirect matches and force=true', async (t) => {
    await withSiteBuilder('site-with-shadowing-force-true', async (builder) => {
      builder
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })
        .withContentFile({
          path: path.join('not-foo', 'index.html'),
          content: '<html><h1>not-foo',
        })
        .withNetlifyToml({
          config: {
            redirects: [{ from: '/foo', to: '/not-foo', status: 301, force: true }],
          },
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const [response, body] = await Promise.all([
          fetch(`${server.url}/foo`, { redirect: 'manual' }),
          fetch(`${server.url}/foo`).then((res) => res.text()),
        ])

        t.expect(response.headers.get('location')).toEqual(`${server.url}/not-foo`)
        t.expect(body).toEqual('<html><h1>not-foo')
      })
    })
  })

  test('should use existing file when rule contains file extension and force=false', async (t) => {
    await withSiteBuilder('site-with-shadowing-file-extension-force-false', async (builder) => {
      builder
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })
        .withContentFile({
          path: path.join('not-foo', 'index.html'),
          content: '<html><h1>not-foo',
        })
        .withNetlifyToml({
          config: {
            redirects: [{ from: '/foo.html', to: '/not-foo', status: 301, force: false }],
          },
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const response = await fetch(`${server.url}/foo.html`, { follow: 0 })
        t.expect(response.headers.location).toBe(undefined)
        t.expect(await response.text()).toEqual('<html><h1>foo')
      })
    })
  })

  test('should redirect when rule contains file extension and force=true', async (t) => {
    await withSiteBuilder('site-with-shadowing-file-extension-force-true', async (builder) => {
      builder
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })
        .withContentFile({
          path: path.join('not-foo', 'index.html'),
          content: '<html><h1>not-foo',
        })
        .withNetlifyToml({
          config: {
            redirects: [{ from: '/foo.html', to: '/not-foo', status: 301, force: true }],
          },
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const [response, body] = await Promise.all([
          fetch(`${server.url}/foo.html`, { redirect: 'manual' }),
          fetch(`${server.url}/foo.html`).then((res) => res.text()),
        ])

        t.expect(response.headers.get('location')).toEqual(`${server.url}/not-foo`)
        t.expect(body).toEqual('<html><h1>not-foo')
      })
    })
  })

  test('should redirect from sub directory to root directory', async (t) => {
    await withSiteBuilder('site-with-shadowing-sub-to-root', async (builder) => {
      builder
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })
        .withContentFile({
          path: path.join('not-foo', 'index.html'),
          content: '<html><h1>not-foo',
        })
        .withNetlifyToml({
          config: {
            redirects: [{ from: '/not-foo', to: '/foo', status: 200, force: true }],
          },
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const [response1, response2, response3] = await Promise.all([
          fetch(`${server.url}/not-foo`).then((res) => res.text()),
          fetch(`${server.url}/not-foo/`).then((res) => res.text()),
          // TODO: check why this doesn't redirect
          fetch(`${server.url}/not-foo/index.html`).then((res) => res.text()),
        ])

        t.expect(response1).toEqual('<html><h1>foo')
        t.expect(response2).toEqual('<html><h1>foo')
        t.expect(response3).toEqual('<html><h1>not-foo')
      })
    })
  })

  test('Runs build plugins with the `onPreDev` event', async (t) => {
    const userServerPort = await getPort()
    const pluginManifest = 'name: local-plugin'

    // This test plugin starts an HTTP server that we'll hit when the dev server
    // is ready, asserting that plugins in dev mode can have long-running jobs.
    const pluginSource = `
    const http = require("http");

    module.exports = {
      onPreBuild: () => {
        throw new Error("I should not run");
      },

      onPreDev: () => {
        const server = http.createServer((_, res) => res.end("Hello world"));

        server.listen(${userServerPort}, "localhost", () => {
          console.log("Server is running on port ${userServerPort}");
        });
      },
    };
  `

    const { temporaryDirectory } = await import('tempy')
    const pluginDirectory = await temporaryDirectory()

    await fs.writeFile(path.join(pluginDirectory, 'manifest.yml'), pluginManifest)
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), pluginSource)

    await withSiteBuilder('site-with-custom-server-in-plugin', async (builder) => {
      builder
        .withNetlifyToml({
          config: {
            plugins: [{ package: path.relative(builder.directory, pluginDirectory) }],
          },
        })
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })

      await builder.buildAsync()

      await withDevServer({ cwd: builder.directory }, async (server) => {
        const [response1, response2] = await Promise.all([
          fetch(`${server.url}/foo`).then((res) => res.text()),
          fetch(`http://localhost:${userServerPort}`).then((res) => res.text()),
        ])
        t.expect(response1).toEqual('<html><h1>foo')
        t.expect(response2).toEqual('Hello world')
      })
    })
  })

  test('Handles errors from the `onPreDev` event', async (t) => {
    const userServerPort = await getPort()
    const pluginManifest = 'name: local-plugin'

    // This test plugin starts an HTTP server that we'll hit when the dev server
    // is ready, asserting that plugins in dev mode can have long-running jobs.
    const pluginSource = `
    const http = require("http");

    module.exports = {
      onPreBuild: () => {
        throw new Error("I should not run");
      },

      onPreDev: () => {
        throw new Error("Something went wrong");
      },
    };
  `

    const { temporaryDirectory } = await import('tempy')
    const pluginDirectory = await temporaryDirectory()

    await fs.writeFile(path.join(pluginDirectory, 'manifest.yml'), pluginManifest)
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), pluginSource)

    await withSiteBuilder('site-with-custom-server-in-plugin', async (builder) => {
      builder
        .withNetlifyToml({
          config: {
            plugins: [{ package: path.relative(builder.directory, pluginDirectory) }],
          },
        })
        .withContentFile({
          path: 'foo.html',
          content: '<html><h1>foo',
        })

      await builder.buildAsync()

      t.expect(() =>
        withDevServer(
          { cwd: builder.directory },
          async (server) => {
            const [response1, response2] = await Promise.all([
              fetch(`${server.url}/foo`).then((res) => res.text()),
              fetch(`http://localhost:${userServerPort}`).then((res) => res.text()),
            ])
            await t.expect(response1).toEqual('<html><h1>foo')
            await t.expect(response2).toEqual('Hello world')
          },
          { message: /Error: Something went wrong/ },
        ),
      ).rejects.toThrowError()
    })
  })
})
