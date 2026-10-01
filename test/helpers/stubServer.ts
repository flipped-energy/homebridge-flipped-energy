import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

export interface StubServer {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

export type StubHandler = (request: IncomingMessage, response: ServerResponse) => void

export async function startStub(handler: StubHandler): Promise<StubServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const { method, url } = request
    if (method === undefined || url === undefined) throw new Error(`stub server request without method or url: ${String(method)} ${String(url)}`)
    requests.push({ method, url, headers: request.headers })
    handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error(`stub server address is ${JSON.stringify(address)}`)
  const { port } = address satisfies AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}
