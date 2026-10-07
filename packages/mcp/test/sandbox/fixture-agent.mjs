// A stand-in agent CLI for the sandbox integration test: a real process that tries what a prompt-injected agent would,
// and prints one JSON line with what happened. Usage: fixture-agent.mjs <plan.json> <prompt…>
import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'

const outcome = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, code: e.code ?? String(e.message) }
  }
}

/** An HTTP request through the sandbox's proxy, by hand: clients skip the proxy for localhost (srt's NO_PROXY). */
const viaProxy = (url) =>
  new Promise((resolve) => {
    const proxy = new URL(process.env.HTTP_PROXY ?? 'http://localhost:1')
    const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : ''
    const sock = connect(Number(proxy.port), proxy.hostname, () => sock.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${auth}Connection: close\r\n\r\n`))
    let data = ''
    sock.setTimeout(5000, () => sock.destroy(new Error('timeout')))
    sock.on('data', (d) => (data += d))
    sock.on('error', (e) => resolve({ ok: false, code: e.code ?? e.message }))
    sock.on('close', () => {
      const status = Number(data.split(' ')[1])
      resolve({ ok: status === 200, status, body: data.slice(data.indexOf('\r\n\r\n') + 4) })
    })
  })

const direct = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return { ok: r.ok, status: r.status }
  } catch (e) {
    return { ok: false, code: e.code ?? e.cause?.code ?? String(e.message) }
  }
}

const [planFile, ...prompt] = process.argv.slice(2)
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const result = {
  argv: prompt,
  readSecret: outcome(() => readFileSync(plan.secret, 'utf8')),
  readWorkdir: outcome(() => readFileSync(plan.workdirFile, 'utf8')),
  writeWorkdir: outcome(() => writeFileSync(plan.workdirOut, 'written')),
  writeOutside: outcome(() => writeFileSync(plan.outside, 'escaped')),
  writeConfig: outcome(() => writeFileSync(plan.configFile, 'pwned')),
  allowed: await viaProxy(plan.allowedUrl),
  denied: await viaProxy(plan.deniedUrl),
  deniedDomain: await direct(plan.deniedDomainUrl),
}
process.stdout.write(JSON.stringify(result) + '\n')
