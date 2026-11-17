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

  it('builds the simulate command with the bridge enabled and no daemon', () => {
    const c = simulateCommand()
    expect(c.env.CRUCIBLE_BRIDGE).toBe('1')
    expect(c.args.join(' ')).toContain('simulateJava')
    expect(c.args.join(' ')).toContain('--no-daemon')
  })
})
