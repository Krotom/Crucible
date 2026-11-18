import { describe, expect, it } from 'vitest'
import { RobotLauncher, simulateCommand } from '../src/main/robot'

describe('RobotLauncher', () => {
  it('streams output lines, passes the environment, and stops the whole process tree', async () => {
    const lines: string[] = []
    let exited: number | null | undefined
    const script = "console.log('bridge=' + process.env.CRUCIBLE_BRIDGE); setInterval(() => console.log('tick'), 30)"
    const l = new RobotLauncher({
      cwd: process.cwd(), command: process.execPath, args: ['-e', script], env: { CRUCIBLE_BRIDGE: '1' },
      onLog: (x) => lines.push(x), onExit: (c) => { exited = c },
    })
    l.start()
    expect(l.running).toBe(true)
    await expect.poll(() => lines.filter((x) => x === 'tick').length, { timeout: 5000 }).toBeGreaterThan(2)
    expect(lines).toContain('bridge=1')
    await l.stop()
    expect(l.running).toBe(false)
    expect(exited).not.toBeUndefined()
    const n = lines.length
    await new Promise((r) => setTimeout(r, 200))
    expect(lines.length).toBe(n) // nothing keeps printing after stop
  })

  it('killNow stops the process at once (the last moments of the app), and does nothing when nothing runs', async () => {
    const lines: string[] = []
    const l = new RobotLauncher({ cwd: process.cwd(), command: process.execPath, args: ['-e', "console.log('pid=' + process.pid); setInterval(() => {}, 1000)"], onLog: (x) => lines.push(x), onExit: () => {} })
    l.killNow() // nothing started yet: no error
    l.start()
    await expect.poll(() => lines.some((x) => x.startsWith('pid=')), { timeout: 5000 }).toBe(true)
    const pid = Number(lines.find((x) => x.startsWith('pid='))!.slice(4))
    const alive = (): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive()).toBe(true)
    l.killNow()
    await expect.poll(alive, { timeout: 5000 }).toBe(false)
    l.killNow() // already gone: no error
  })

  it('reports a last line that has no newline before the exit', async () => {
    const lines: string[] = []
    const events: string[] = []
    const l = new RobotLauncher({
      cwd: process.cwd(), command: process.execPath, args: ['-e', "process.stdout.write('first\\nBUILD FAILED without newline')"],
      onLog: (x) => { lines.push(x); events.push('log:' + x) }, onExit: (c) => events.push('exit:' + c),
    })
    l.start()
    await expect.poll(() => events.some((e) => e.startsWith('exit:')), { timeout: 5000 }).toBe(true)
    expect(lines).toEqual(['first', 'BUILD FAILED without newline'])
    expect(events[events.length - 1]).toBe('exit:0') // the line comes before the exit
  })

  it('still reports the exit when a grandchild keeps the output pipe open', async () => {
    let exited: number | null | undefined
    const script = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 3000)'], { stdio: 'inherit', detached: true }).unref(); console.log('parent done')"
    const l = new RobotLauncher({ cwd: process.cwd(), command: process.execPath, args: ['-e', script], onLog: () => {}, onExit: (c) => { exited = c } })
    const t0 = Date.now()
    l.start()
    await expect.poll(() => exited, { timeout: 2500 }).toBe(0)
    expect(Date.now() - t0).toBeLessThan(2500)
  })

  it('builds the simulate command with the bridge enabled and no daemon', () => {
    const c = simulateCommand()
    expect(c.env.CRUCIBLE_BRIDGE).toBe('1')
    expect(c.args.join(' ')).toContain('simulateJava')
    expect(c.args.join(' ')).toContain('--no-daemon')
  })
})
