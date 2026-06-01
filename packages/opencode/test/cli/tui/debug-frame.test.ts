import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { createDebugFrameTransport } from "../../../src/cli/cmd/tui/debug/frame"

const fixture = fileURLToPath(
  new URL("../../../src/cli/cmd/tui/debug/fixtures/subagent-lifecycle.json", import.meta.url),
)

describe("TUI debug frames", () => {
  test("compiles completed direct and child-tool subagents into distinct sessions", async () => {
    const transport = await createDebugFrameTransport({ file: fixture, frame: "completed", directory: "/tmp/project" })
    const transcript = (await (
      await transport.fetch(`http://opencode.debug/session/${transport.sessionID}/message`)
    ).json()) as Array<{ info: Message; parts: Part[] }>
    const tasks = transcript[1]!.parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
    const directID = completedMetadata(tasks[1]!).sessionId as string
    const readID = completedMetadata(tasks[2]!).sessionId as string
    const direct = (await (
      await transport.fetch(`http://opencode.debug/session/${directID}/message`)
    ).json()) as Array<{ info: Message; parts: Part[] }>
    const read = (await (await transport.fetch(`http://opencode.debug/session/${readID}/message`)).json()) as Array<{
      info: Message
      parts: Part[]
    }>

    expect(directID).not.toBe(readID)
    expect(direct[1]!.parts).toHaveLength(0)
    expect(read[1]!.parts.filter((part) => part.type === "tool")).toHaveLength(1)
    if (direct[1]!.info.role !== "assistant" || direct[1]!.info.time.completed === undefined) {
      throw new Error("Expected completed child response")
    }
    expect(direct[1]!.info.time.completed - direct[0]!.info.time.created).toBe(501)
  })

  test("marks only active background children busy", async () => {
    const transport = await createDebugFrameTransport({
      file: fixture,
      frame: "active-background",
      directory: "/tmp/project",
    })
    const status = (await (await transport.fetch("http://opencode.debug/session/status")).json()) as Record<
      string,
      { type: string }
    >

    expect(Object.values(status)).toEqual([{ type: "busy" }])
  })

  test("compiles retrying and failed subagent states", async () => {
    const retrying = await createDebugFrameTransport({ file: fixture, frame: "retrying", directory: "/tmp/project" })
    const retryTranscript = (await (
      await retrying.fetch(`http://opencode.debug/session/${retrying.sessionID}/message`)
    ).json()) as Array<{ parts: Part[] }>
    const retryTask = retryTranscript[1]!.parts.find(
      (part): part is ToolPart => part.type === "tool" && part.tool === "task",
    )!
    const retryID = runningMetadata(retryTask).sessionId as string
    const status = (await (await retrying.fetch("http://opencode.debug/session/status")).json()) as Record<
      string,
      { type: string; attempt?: number }
    >
    const failed = await createDebugFrameTransport({ file: fixture, frame: "failed", directory: "/tmp/project" })
    const failedTranscript = (await (
      await failed.fetch(`http://opencode.debug/session/${failed.sessionID}/message`)
    ).json()) as Array<{ parts: Part[] }>
    const failedTask = failedTranscript[1]!.parts.find(
      (part): part is ToolPart => part.type === "tool" && part.tool === "task",
    )!

    expect(status[retryID]).toMatchObject({ type: "retry", attempt: 2 })
    expect(failedTask.state.status).toBe("error")
  })

  test("reports available frames for unknown selection", async () => {
    await expect(
      createDebugFrameTransport({ file: fixture, frame: "missing", directory: "/tmp/project" }),
    ).rejects.toThrow("Available frames: running, active-background, retrying, failed, completed")
  })

  test("rejects mutations against static debug frames", async () => {
    const transport = await createDebugFrameTransport({ file: fixture, frame: "completed", directory: "/tmp/project" })

    await expect(
      transport.fetch(`http://opencode.debug/session/${transport.sessionID}/message`, { method: "POST" }),
    ).rejects.toThrow("Unexpected debug frame request: POST")
  })
})

function completedMetadata(part: ToolPart) {
  if (part.state.status !== "completed") throw new Error("Expected completed task")
  return part.state.metadata
}

function runningMetadata(part: ToolPart) {
  if (part.state.status !== "running") throw new Error("Expected running task")
  return part.state.metadata ?? {}
}
