import type {
  AssistantMessage,
  Message,
  Part,
  Session,
  SessionStatus,
  TextPart,
  ToolPart,
  ToolState,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { Schema } from "effect"
import type { EventSource } from "../context/sdk"

const Data = Schema.Record(Schema.String, Schema.Unknown)
const ChildTool = Schema.Struct({
  tool: Schema.String,
  title: Schema.String,
  state: Schema.optional(Schema.Literals(["running", "completed", "error"])),
  input: Schema.optional(Data),
  metadata: Schema.optional(Data),
})
const SubagentFields = {
  type: Schema.Literal("subagent"),
  agent: Schema.String,
  description: Schema.String,
  durationMs: Schema.optional(Schema.Number),
  childTools: Schema.optional(Schema.Array(ChildTool)),
}
const PartInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    tool: Schema.String,
    title: Schema.String,
    state: Schema.optional(Schema.Literals(["running", "completed", "error"])),
    input: Schema.optional(Data),
    metadata: Schema.optional(Data),
  }),
  Schema.Struct({ ...SubagentFields, state: Schema.Literal("running") }),
  Schema.Struct({ ...SubagentFields, state: Schema.Literal("active-background") }),
  Schema.Struct({ ...SubagentFields, state: Schema.Literal("completed"), background: Schema.optional(Schema.Boolean) }),
  Schema.Struct({
    ...SubagentFields,
    state: Schema.Literal("retrying"),
    background: Schema.optional(Schema.Boolean),
    message: Schema.String,
    attempt: Schema.Number,
  }),
  Schema.Struct({
    ...SubagentFields,
    state: Schema.Literal("error"),
    background: Schema.optional(Schema.Boolean),
    error: Schema.String,
  }),
])
const Frame = Schema.Struct({
  prompt: Schema.String,
  parts: Schema.Array(PartInput),
})
const Fixture = Schema.Struct({
  name: Schema.String,
  frames: Schema.Record(Schema.String, Frame),
})
const decodeFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Fixture))

type Transcript = Array<{ info: Message; parts: Part[] }>
type FrameInput = typeof Frame.Type

export async function createDebugFrameTransport(input: { file: string; frame: string; directory: string }) {
  const fixture = decodeFixture(await Bun.file(input.file).text())
  const frame = fixture.frames[input.frame]
  if (!frame) {
    throw new Error(
      `Unknown debug frame "${input.frame}" in ${input.file}. Available frames: ${Object.keys(fixture.frames).join(", ")}`,
    )
  }

  const sessionID = `ses_debug_${fixture.name.replaceAll(/[^a-zA-Z0-9_]/g, "_")}_${input.frame.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`
  const created = 1_000_000
  const root = makeSession(sessionID, input.directory, `${fixture.name}: ${input.frame}`, created)
  const childSessions = new Map<string, { session: Session; transcript: Transcript }>()
  const statuses: Record<string, SessionStatus> = {}
  const parts = compileParts(frame, sessionID, created, input.directory, childSessions, statuses)
  const transcript = turn(sessionID, created, frame.prompt, parts)
  const fetch = createFetch({ root, transcript, childSessions, statuses, directory: input.directory })
  const events: EventSource = { subscribe: async () => () => {} }

  return { sessionID, fetch, events }
}

function compileParts(
  frame: FrameInput,
  sessionID: string,
  created: number,
  directory: string,
  children: Map<string, { session: Session; transcript: Transcript }>,
  statuses: Record<string, SessionStatus>,
) {
  return frame.parts.map((part, index): Part => {
    const id = `part_${index.toString().padStart(2, "0")}`
    if (part.type === "text") return text(sessionID, assistantID(sessionID), id, part.text)
    if (part.type === "tool") {
      return tool(
        sessionID,
        assistantID(sessionID),
        id,
        part.tool,
        toolState(part.state ?? "completed", part.input ?? {}, part.metadata ?? {}, part.title, created),
      )
    }

    const childID = `${sessionID}_child_${index}`
    const childTools = part.childTools ?? []
    const complete = part.state === "completed"
    children.set(childID, {
      session: { ...makeSession(childID, directory, part.description, created), parentID: sessionID },
      transcript: turn(
        childID,
        created,
        part.description,
        childTools.map((child, childIndex) =>
          tool(
            childID,
            assistantID(childID),
            `part_child_${childIndex}`,
            child.tool,
            toolState(
              child.state ?? (complete ? "completed" : "running"),
              child.input ?? {},
              child.metadata ?? {},
              child.title,
              created,
            ),
          ),
        ),
        complete,
        part.durationMs ?? 501,
      ),
    })
    if (part.state === "active-background") statuses[childID] = { type: "busy" }
    if (part.state === "retrying") {
      statuses[childID] = { type: "retry", attempt: part.attempt, message: part.message, next: created + 1000 }
    }
    const state = part.state === "completed" ? "completed" : part.state === "error" ? "error" : "running"
    const background =
      part.state === "active-background" ||
      ((part.state === "completed" || part.state === "retrying" || part.state === "error") && part.background === true)
    return tool(
      sessionID,
      assistantID(sessionID),
      id,
      "task",
      toolState(
        state,
        {
          description: part.description,
          subagent_type: part.agent,
        },
        {
          sessionId: childID,
          ...(background ? { background: true } : {}),
        },
        part.state === "error" ? part.error : part.description,
        created,
      ),
    )
  })
}

function createFetch(input: {
  root: Session
  transcript: Transcript
  childSessions: Map<string, { session: Session; transcript: Transcript }>
  statuses: Record<string, SessionStatus>
  directory: string
}) {
  const provider = {
    id: "debug-frame",
    name: "Debug Frame",
    source: "custom",
    env: [],
    options: {},
    models: {
      preview: {
        id: "preview",
        providerID: "debug-frame",
        api: { id: "preview", url: "", npm: "" },
        name: "Preview",
        capabilities: {
          temperature: false,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 1, output: 1 },
        status: "active",
        options: {},
        headers: {},
        release_date: "",
      },
    },
  }
  return Object.assign(
    async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init)
      const pathname = new URL(request.url).pathname
      if (request.method !== "GET") throw new Error(`Unexpected debug frame request: ${request.method} ${pathname}`)
      const child = input.childSessions.get(pathname.split("/")[2] ?? "")
      if (request.method === "GET" && pathname === `/session/${input.root.id}`) return json(input.root)
      if (request.method === "GET" && pathname === `/session/${input.root.id}/message`) return json(input.transcript)
      if (request.method === "GET" && child && pathname === `/session/${child.session.id}`) return json(child.session)
      if (request.method === "GET" && child && pathname === `/session/${child.session.id}/message`)
        return json(child.transcript)
      if (request.method === "GET" && (pathname.endsWith("/todo") || pathname.endsWith("/diff"))) return json([])
      switch (pathname) {
        case "/agent":
          return json([
            {
              name: "build",
              description: "Internal debug frame",
              mode: "primary",
              native: true,
              permission: [],
              model: { providerID: "debug-frame", modelID: "preview" },
              options: {},
            },
          ])
        case "/config/providers":
          return json({ providers: [provider], default: { "debug-frame": "preview" } })
        case "/provider":
          return json({ all: [], default: { "debug-frame": "preview" }, connected: ["debug-frame"] })
        case "/session":
          return json([input.root])
        case "/session/status":
          return json(input.statuses)
        case "/path":
          return json({ home: "", state: "", config: "", worktree: input.directory, directory: input.directory })
        case "/project/current":
          return json({ id: "debug-frame" })
        case "/vcs":
          return json({ branch: "debug-frame" })
        case "/command":
        case "/experimental/workspace":
        case "/experimental/workspace/status":
        case "/formatter":
        case "/lsp":
          return json([])
        case "/config":
        case "/experimental/resource":
        case "/mcp":
        case "/provider/auth":
          return json({})
        case "/experimental/console":
          return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      }
      throw new Error(`Unexpected debug frame request: ${request.method} ${pathname}`)
    },
    { preconnect: fetch.preconnect },
  )
}

function makeSession(id: string, directory: string, title: string, created: number): Session {
  return {
    id,
    slug: id,
    projectID: "global",
    directory,
    title,
    version: "debug-frame",
    time: { created, updated: created },
  }
}

function turn(
  sessionID: string,
  created: number,
  prompt: string,
  parts: Part[],
  complete = true,
  durationMs = 501,
): Transcript {
  return [
    { info: userMessage(sessionID, created), parts: [text(sessionID, userID(sessionID), "part_user", prompt)] },
    { info: assistantMessage(sessionID, created + 1, complete ? created + durationMs : undefined), parts },
  ]
}

function userMessage(sessionID: string, created: number): UserMessage {
  return {
    id: userID(sessionID),
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "debug-frame", modelID: "preview" },
  }
}

function assistantMessage(sessionID: string, created: number, completed?: number): AssistantMessage {
  return {
    id: assistantID(sessionID),
    sessionID,
    role: "assistant",
    time: { created, ...(completed === undefined ? {} : { completed }) },
    parentID: userID(sessionID),
    modelID: "preview",
    providerID: "debug-frame",
    mode: "build",
    agent: "build",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(completed === undefined ? {} : { finish: "stop" }),
  }
}

function userID(sessionID: string) {
  return `msg_${sessionID}_user`
}

function assistantID(sessionID: string) {
  return `msg_${sessionID}_assistant`
}

function text(sessionID: string, messageID: string, id: string, value: string): TextPart {
  return { id, sessionID, messageID, type: "text", text: value }
}

function tool(sessionID: string, messageID: string, id: string, name: string, state: ToolState): ToolPart {
  return { id, sessionID, messageID, type: "tool", callID: `call_${id}`, tool: name, state }
}

function toolState(
  state: "running" | "completed" | "error",
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  title: string,
  created: number,
): ToolState {
  if (state === "running") return { status: "running", input, metadata, title, time: { start: created } }
  if (state === "error") {
    return { status: "error", input, metadata, error: title, time: { start: created, end: created + 1 } }
  }
  return {
    status: "completed",
    input,
    metadata,
    output: title,
    title,
    time: { start: created, end: created + 1 },
  }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
}
