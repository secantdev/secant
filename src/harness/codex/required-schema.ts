import { z } from "zod";

const discriminatorSchema = z.looseObject({ enum: z.array(z.string()) });
const variantSchema = z.looseObject({
  properties: z.looseObject({
    method: discriminatorSchema.optional(),
    type: discriminatorSchema.optional(),
  }),
  required: z.array(z.string()).optional(),
});
const variantsSchema = z.looseObject({ oneOf: z.array(variantSchema) });
const enumSchema = z.looseObject({ enum: z.array(z.string()) });
const shapeSchema = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});
const literalUnionSchema = z.looseObject({
  oneOf: z.array(z.looseObject({ enum: z.array(z.string()).optional() })),
});
const primitiveUnionSchema = z.looseObject({
  anyOf: z.array(z.looseObject({ type: z.string().optional() })),
});
const generatedSchema = z.looseObject({
  definitions: z.looseObject({
    ClientRequest: variantsSchema,
    ClientNotification: variantsSchema,
    ServerNotification: variantsSchema,
    ServerRequest: variantsSchema,
    InitializeParams: shapeSchema,
    InitializeResponse: shapeSchema,
    CommandExecutionRequestApprovalParams: shapeSchema,
    CommandExecutionRequestApprovalResponse: shapeSchema,
    CommandExecutionApprovalDecision: literalUnionSchema,
    CommandExecutionApprovalKind: enumSchema,
    FileChangeRequestApprovalParams: shapeSchema,
    FileChangeRequestApprovalResponse: shapeSchema,
    FileChangeApprovalDecision: literalUnionSchema,
    v2: z.looseObject({
      TurnStatus: enumSchema,
      CommandExecutionStatus: enumSchema,
      PatchApplyStatus: enumSchema,
      McpToolCallStatus: enumSchema,
      DynamicToolCallStatus: enumSchema,
      CollabAgentToolCallStatus: enumSchema,
      ThreadItem: variantsSchema,
      FileUpdateChange: shapeSchema,
      PatchChangeKind: variantsSchema,
      Thread: shapeSchema,
      Turn: shapeSchema,
      ThreadStartParams: shapeSchema,
      ThreadStartResponse: shapeSchema,
      ThreadResumeParams: shapeSchema,
      ThreadResumeResponse: shapeSchema,
      TurnStartParams: shapeSchema,
      TurnStartResponse: shapeSchema,
      TurnSteerParams: shapeSchema,
      TurnSteerResponse: shapeSchema,
      TurnInterruptParams: shapeSchema,
      TurnInterruptResponse: shapeSchema,
      ModelListParams: shapeSchema,
      ModelListResponse: shapeSchema,
      GetAccountParams: shapeSchema,
      GetAccountResponse: shapeSchema,
      ErrorNotification: shapeSchema,
      TurnStartedNotification: shapeSchema,
      TurnCompletedNotification: shapeSchema,
      ItemStartedNotification: shapeSchema,
      ItemCompletedNotification: shapeSchema,
      AgentMessageDeltaNotification: shapeSchema,
      CommandExecutionOutputDeltaNotification: shapeSchema,
      FileChangeOutputDeltaNotification: shapeSchema,
      FileChangePatchUpdatedNotification: shapeSchema,
      ServerRequestResolvedNotification: shapeSchema,
      McpToolCallProgressNotification: shapeSchema,
      RequestId: primitiveUnionSchema,
    }),
  }),
});

type TRequiredVariants = Readonly<Record<string, readonly string[]>>;

const CLIENT_REQUESTS: TRequiredVariants = {
  initialize: ["id", "method", "params"],
  "thread/start": ["id", "method", "params"],
  "thread/resume": ["id", "method", "params"],
  "turn/start": ["id", "method", "params"],
  "turn/steer": ["id", "method", "params"],
  "turn/interrupt": ["id", "method", "params"],
  "model/list": ["id", "method", "params"],
  "account/read": ["id", "method", "params"],
};

const CLIENT_NOTIFICATIONS: TRequiredVariants = {
  initialized: ["method"],
};

const SERVER_NOTIFICATIONS: TRequiredVariants = {
  error: ["method", "params"],
  "thread/started": ["method", "params"],
  "turn/started": ["method", "params"],
  "turn/completed": ["method", "params"],
  "item/started": ["method", "params"],
  "item/completed": ["method", "params"],
  "item/agentMessage/delta": ["method", "params"],
  "item/commandExecution/outputDelta": ["method", "params"],
  "item/fileChange/outputDelta": ["method", "params"],
  "item/fileChange/patchUpdated": ["method", "params"],
  "serverRequest/resolved": ["method", "params"],
  "item/mcpToolCall/progress": ["method", "params"],
};

const SERVER_REQUESTS: TRequiredVariants = {
  "item/commandExecution/requestApproval": ["id", "method", "params"],
  "item/fileChange/requestApproval": ["id", "method", "params"],
};

const THREAD_ITEMS: TRequiredVariants = {
  userMessage: ["id", "content", "type"],
  agentMessage: ["id", "text", "type"],
  reasoning: ["id", "type"],
  commandExecution: ["id", "command", "status", "type"],
  fileChange: ["id", "changes", "status", "type"],
  mcpToolCall: ["id", "server", "tool", "status", "type"],
  dynamicToolCall: ["id", "tool", "status", "type"],
  collabAgentToolCall: ["id", "status", "type"],
  webSearch: ["id", "query", "type"],
  imageView: ["id", "path", "type"],
  imageGeneration: ["id", "status", "type"],
};

const TURN_STATUSES = ["completed", "interrupted", "failed", "inProgress"];
const FILE_CHANGE_KINDS: TRequiredVariants = {
  add: ["type"],
  delete: ["type"],
  update: ["type"],
};

const CLIENT_REQUEST_PARAM_REFS: Readonly<Record<string, string>> = {
  initialize: "#/definitions/InitializeParams",
  "thread/start": "#/definitions/v2/ThreadStartParams",
  "thread/resume": "#/definitions/v2/ThreadResumeParams",
  "turn/start": "#/definitions/v2/TurnStartParams",
  "turn/steer": "#/definitions/v2/TurnSteerParams",
  "turn/interrupt": "#/definitions/v2/TurnInterruptParams",
  "model/list": "#/definitions/v2/ModelListParams",
  "account/read": "#/definitions/v2/GetAccountParams",
};

const SERVER_NOTIFICATION_PARAM_REFS: Readonly<Record<string, string>> = {
  error: "#/definitions/v2/ErrorNotification",
  "thread/started": "#/definitions/v2/ThreadStartedNotification",
  "turn/started": "#/definitions/v2/TurnStartedNotification",
  "turn/completed": "#/definitions/v2/TurnCompletedNotification",
  "item/started": "#/definitions/v2/ItemStartedNotification",
  "item/completed": "#/definitions/v2/ItemCompletedNotification",
  "item/agentMessage/delta": "#/definitions/v2/AgentMessageDeltaNotification",
  "item/commandExecution/outputDelta":
    "#/definitions/v2/CommandExecutionOutputDeltaNotification",
  "item/fileChange/outputDelta":
    "#/definitions/v2/FileChangeOutputDeltaNotification",
  "item/fileChange/patchUpdated":
    "#/definitions/v2/FileChangePatchUpdatedNotification",
  "serverRequest/resolved":
    "#/definitions/v2/ServerRequestResolvedNotification",
  "item/mcpToolCall/progress":
    "#/definitions/v2/McpToolCallProgressNotification",
};

const SERVER_REQUEST_PARAM_REFS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval":
    "#/definitions/CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval":
    "#/definitions/FileChangeRequestApprovalParams",
};

const SERVER_REQUEST_ID_REFS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "#/definitions/v2/RequestId",
  "item/fileChange/requestApproval": "#/definitions/v2/RequestId",
};

const THREAD_ITEM_FIELD_TYPES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  userMessage: { id: "string", content: "array" },
  agentMessage: { id: "string", text: "string" },
  reasoning: { id: "string" },
  commandExecution: { id: "string", command: "string" },
  fileChange: { id: "string", changes: "array" },
  mcpToolCall: { id: "string", server: "string", tool: "string" },
  dynamicToolCall: { id: "string", tool: "string" },
  collabAgentToolCall: { id: "string" },
  webSearch: { id: "string", query: "string" },
  imageView: { id: "string" },
  imageGeneration: { id: "string", status: "string" },
};

const THREAD_ITEM_FIELD_REFS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  commandExecution: {
    status: "#/definitions/v2/CommandExecutionStatus",
  },
  fileChange: { status: "#/definitions/v2/PatchApplyStatus" },
  mcpToolCall: { status: "#/definitions/v2/McpToolCallStatus" },
  dynamicToolCall: { status: "#/definitions/v2/DynamicToolCallStatus" },
  collabAgentToolCall: {
    status: "#/definitions/v2/CollabAgentToolCallStatus",
  },
  imageView: { path: "#/definitions/v2/LegacyAppPathString" },
};

const THREAD_ITEM_ARRAY_ITEM_REFS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  fileChange: { changes: "#/definitions/v2/FileUpdateChange" },
};

interface TSchemaFact {
  readonly path: readonly string[];
  readonly expected: string;
  readonly label: string;
}

const REQUIRED_SCHEMA_FACTS: readonly TSchemaFact[] = [
  fact(
    "initialize client info",
    "#/definitions/ClientInfo",
    "definitions",
    "InitializeParams",
    "properties",
    "clientInfo",
    "$ref",
  ),
  fact(
    "experimental API opt-out",
    "boolean",
    "definitions",
    "InitializeCapabilities",
    "properties",
    "experimentalApi",
    "type",
  ),
  fact(
    "initialize user agent",
    "string",
    "definitions",
    "InitializeResponse",
    "properties",
    "userAgent",
    "type",
  ),
  fact(
    "initialize Codex home",
    "#/definitions/v2/AbsolutePathBuf",
    "definitions",
    "InitializeResponse",
    "properties",
    "codexHome",
    "allOf",
    "0",
    "$ref",
  ),
  fact(
    "initialize platform family",
    "string",
    "definitions",
    "InitializeResponse",
    "properties",
    "platformFamily",
    "type",
  ),
  fact(
    "initialize platform OS",
    "string",
    "definitions",
    "InitializeResponse",
    "properties",
    "platformOs",
    "type",
  ),
  fact(
    "thread/start response",
    "#/definitions/v2/Thread",
    "definitions",
    "v2",
    "ThreadStartResponse",
    "properties",
    "thread",
    "$ref",
  ),
  fact(
    "thread/resume id",
    "string",
    "definitions",
    "v2",
    "ThreadResumeParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "thread/resume response",
    "#/definitions/v2/Thread",
    "definitions",
    "v2",
    "ThreadResumeResponse",
    "properties",
    "thread",
    "$ref",
  ),
  fact(
    "turn/start thread id",
    "string",
    "definitions",
    "v2",
    "TurnStartParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "turn/start input",
    "array",
    "definitions",
    "v2",
    "TurnStartParams",
    "properties",
    "input",
    "type",
  ),
  fact(
    "turn/start response",
    "#/definitions/v2/Turn",
    "definitions",
    "v2",
    "TurnStartResponse",
    "properties",
    "turn",
    "$ref",
  ),
  fact(
    "turn/steer expected id",
    "string",
    "definitions",
    "v2",
    "TurnSteerParams",
    "properties",
    "expectedTurnId",
    "type",
  ),
  fact(
    "turn/steer input",
    "array",
    "definitions",
    "v2",
    "TurnSteerParams",
    "properties",
    "input",
    "type",
  ),
  fact(
    "turn/interrupt thread id",
    "string",
    "definitions",
    "v2",
    "TurnInterruptParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "turn/interrupt turn id",
    "string",
    "definitions",
    "v2",
    "TurnInterruptParams",
    "properties",
    "turnId",
    "type",
  ),
  fact(
    "model list data",
    "array",
    "definitions",
    "v2",
    "ModelListResponse",
    "properties",
    "data",
    "type",
  ),
  fact(
    "account auth requirement",
    "boolean",
    "definitions",
    "v2",
    "GetAccountResponse",
    "properties",
    "requiresOpenaiAuth",
    "type",
  ),
  fact(
    "thread id",
    "string",
    "definitions",
    "v2",
    "Thread",
    "properties",
    "id",
    "type",
  ),
  fact(
    "Turn id",
    "string",
    "definitions",
    "v2",
    "Turn",
    "properties",
    "id",
    "type",
  ),
  fact(
    "Turn items",
    "array",
    "definitions",
    "v2",
    "Turn",
    "properties",
    "items",
    "type",
  ),
  fact(
    "Turn status",
    "#/definitions/v2/TurnStatus",
    "definitions",
    "v2",
    "Turn",
    "properties",
    "status",
    "$ref",
  ),
  fact(
    "command approval decision",
    "#/definitions/CommandExecutionApprovalDecision",
    "definitions",
    "CommandExecutionRequestApprovalResponse",
    "properties",
    "decision",
    "$ref",
  ),
  fact(
    "command approval kind",
    "#/definitions/CommandExecutionApprovalKind",
    "definitions",
    "CommandExecutionRequestApprovalParams",
    "properties",
    "kind",
    "allOf",
    "0",
    "$ref",
  ),
  fact(
    "file approval decision",
    "#/definitions/FileChangeApprovalDecision",
    "definitions",
    "FileChangeRequestApprovalResponse",
    "properties",
    "decision",
    "$ref",
  ),
  fact(
    "error notification error",
    "#/definitions/v2/TurnError",
    "definitions",
    "v2",
    "ErrorNotification",
    "properties",
    "error",
    "$ref",
  ),
  fact(
    "error notification retry",
    "boolean",
    "definitions",
    "v2",
    "ErrorNotification",
    "properties",
    "willRetry",
    "type",
  ),
  fact(
    "turn/completed thread id",
    "string",
    "definitions",
    "v2",
    "TurnCompletedNotification",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "turn/completed Turn",
    "#/definitions/v2/Turn",
    "definitions",
    "v2",
    "TurnCompletedNotification",
    "properties",
    "turn",
    "$ref",
  ),
  fact(
    "item/started item",
    "#/definitions/v2/ThreadItem",
    "definitions",
    "v2",
    "ItemStartedNotification",
    "properties",
    "item",
    "$ref",
  ),
  fact(
    "item/completed item",
    "#/definitions/v2/ThreadItem",
    "definitions",
    "v2",
    "ItemCompletedNotification",
    "properties",
    "item",
    "$ref",
  ),
  fact(
    "agent delta",
    "string",
    "definitions",
    "v2",
    "AgentMessageDeltaNotification",
    "properties",
    "delta",
    "type",
  ),
  fact(
    "command delta",
    "string",
    "definitions",
    "v2",
    "CommandExecutionOutputDeltaNotification",
    "properties",
    "delta",
    "type",
  ),
  fact(
    "file delta",
    "string",
    "definitions",
    "v2",
    "FileChangeOutputDeltaNotification",
    "properties",
    "delta",
    "type",
  ),
  fact(
    "command approval item id",
    "string",
    "definitions",
    "CommandExecutionRequestApprovalParams",
    "properties",
    "itemId",
    "type",
  ),
  fact(
    "file approval item id",
    "string",
    "definitions",
    "FileChangeRequestApprovalParams",
    "properties",
    "itemId",
    "type",
  ),
  fact(
    "command approval thread id",
    "string",
    "definitions",
    "CommandExecutionRequestApprovalParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "command approval turn id",
    "string",
    "definitions",
    "CommandExecutionRequestApprovalParams",
    "properties",
    "turnId",
    "type",
  ),
  fact(
    "file approval thread id",
    "string",
    "definitions",
    "FileChangeRequestApprovalParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "file approval turn id",
    "string",
    "definitions",
    "FileChangeRequestApprovalParams",
    "properties",
    "turnId",
    "type",
  ),
  fact(
    "file change path",
    "string",
    "definitions",
    "v2",
    "FileUpdateChange",
    "properties",
    "path",
    "type",
  ),
  fact(
    "file change kind",
    "#/definitions/v2/PatchChangeKind",
    "definitions",
    "v2",
    "FileUpdateChange",
    "properties",
    "kind",
    "$ref",
  ),
  fact(
    "request resolution id",
    "#/definitions/v2/RequestId",
    "definitions",
    "v2",
    "ServerRequestResolvedNotification",
    "properties",
    "requestId",
    "$ref",
  ),
  fact(
    "request resolution thread id",
    "string",
    "definitions",
    "v2",
    "ServerRequestResolvedNotification",
    "properties",
    "threadId",
    "type",
  ),
];

export type TSchemaValidation =
  { readonly ok: true } | { readonly ok: false; readonly diagnostics: string };

/** Compare the generated stable schema with the exact structural subset the M4
 *  Adapter interprets. Additive methods and fields remain compatible; a missing
 *  variant, discriminator, required field, item kind, or terminal status fails
 *  closed before an app-server child is launched. */
export function validateRequiredSchema(value: unknown): TSchemaValidation {
  const parsed = generatedSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: `generated schema has no readable stable protocol bundle: ${z.prettifyError(parsed.error)}`,
    };
  }

  const definitions = parsed.data.definitions;
  const checks = [
    validateVariants(
      definitions.ClientRequest.oneOf,
      "method",
      CLIENT_REQUESTS,
      "client request",
    ),
    validateVariants(
      definitions.ClientNotification.oneOf,
      "method",
      CLIENT_NOTIFICATIONS,
      "client notification",
    ),
    validateVariants(
      definitions.ServerNotification.oneOf,
      "method",
      SERVER_NOTIFICATIONS,
      "server notification",
    ),
    validateVariants(
      definitions.ServerRequest.oneOf,
      "method",
      SERVER_REQUESTS,
      "server request",
    ),
    validateVariants(
      definitions.v2.ThreadItem.oneOf,
      "type",
      THREAD_ITEMS,
      "thread item",
    ),
    validateVariants(
      definitions.v2.PatchChangeKind.oneOf,
      "type",
      FILE_CHANGE_KINDS,
      "file change kind",
    ),
    validateShape(
      definitions.v2.FileUpdateChange,
      ["path", "kind"],
      "file change",
    ),
    validateNullableStringField(
      definitions.v2.PatchChangeKind.oneOf,
      "update",
      "move_path",
      "file change kind",
    ),
    validateVariantReferences(
      definitions.ClientRequest.oneOf,
      "method",
      CLIENT_REQUEST_PARAM_REFS,
      "client request",
    ),
    validateVariantReferences(
      definitions.ServerNotification.oneOf,
      "method",
      SERVER_NOTIFICATION_PARAM_REFS,
      "server notification",
    ),
    validateVariantReferences(
      definitions.ServerRequest.oneOf,
      "method",
      SERVER_REQUEST_PARAM_REFS,
      "server request",
    ),
    validateVariantFieldReferencesByDiscriminator(
      definitions.ServerRequest.oneOf,
      "method",
      "id",
      SERVER_REQUEST_ID_REFS,
      "server request",
    ),
    validateVariantFieldTypes(
      definitions.v2.ThreadItem.oneOf,
      THREAD_ITEM_FIELD_TYPES,
    ),
    validateVariantFieldReferences(
      definitions.v2.ThreadItem.oneOf,
      THREAD_ITEM_FIELD_REFS,
    ),
    validateVariantArrayItemReferences(
      definitions.v2.ThreadItem.oneOf,
      THREAD_ITEM_ARRAY_ITEM_REFS,
    ),
    validateMembers(
      definitions.v2.TurnStatus.enum,
      TURN_STATUSES,
      "terminal Turn status",
    ),
    validateMembers(
      definitions.v2.CommandExecutionStatus.enum,
      ["inProgress", "completed", "failed", "declined"],
      "command status",
    ),
    validateMembers(
      definitions.v2.PatchApplyStatus.enum,
      ["inProgress", "completed", "failed", "declined"],
      "file-change status",
    ),
    validateMembers(
      definitions.v2.McpToolCallStatus.enum,
      ["inProgress", "completed", "failed"],
      "MCP tool status",
    ),
    validateMembers(
      definitions.v2.DynamicToolCallStatus.enum,
      ["inProgress", "completed", "failed"],
      "dynamic tool status",
    ),
    validateMembers(
      definitions.v2.CollabAgentToolCallStatus.enum,
      ["inProgress", "completed", "failed", "interrupted"],
      "collaboration tool status",
    ),
    validateShape(
      definitions.InitializeParams,
      ["clientInfo"],
      "initialize params",
    ),
    validateShape(
      definitions.InitializeResponse,
      ["codexHome", "platformFamily", "platformOs", "userAgent"],
      "initialize response",
    ),
    validateShape(definitions.v2.ThreadStartParams, [], "thread/start params"),
    validateShape(
      definitions.v2.ThreadStartResponse,
      ["approvalPolicy", "cwd", "model", "modelProvider", "sandbox", "thread"],
      "thread/start response",
    ),
    validateShape(
      definitions.v2.ThreadResumeParams,
      ["threadId"],
      "thread/resume params",
    ),
    validateShape(
      definitions.v2.ThreadResumeResponse,
      ["approvalPolicy", "cwd", "model", "modelProvider", "sandbox", "thread"],
      "thread/resume response",
    ),
    validateShape(
      definitions.v2.TurnStartParams,
      ["input", "threadId"],
      "turn/start params",
    ),
    validateShape(
      definitions.v2.TurnStartResponse,
      ["turn"],
      "turn/start response",
    ),
    validateShape(
      definitions.v2.TurnSteerParams,
      ["expectedTurnId", "input", "threadId"],
      "turn/steer params",
    ),
    validateShape(
      definitions.v2.TurnSteerResponse,
      ["turnId"],
      "turn/steer response",
    ),
    validateShape(
      definitions.v2.TurnInterruptParams,
      ["threadId", "turnId"],
      "turn/interrupt params",
    ),
    validateShape(
      definitions.v2.TurnInterruptResponse,
      [],
      "turn/interrupt response",
    ),
    validateShape(definitions.v2.ModelListParams, [], "model/list params"),
    validateShape(
      definitions.v2.ModelListResponse,
      ["data"],
      "model/list response",
    ),
    validateShape(definitions.v2.GetAccountParams, [], "account/read params"),
    validateShape(
      definitions.v2.GetAccountResponse,
      ["requiresOpenaiAuth"],
      "account/read response",
    ),
    validateShape(definitions.v2.Thread, ["id", "status"], "thread"),
    validateShape(definitions.v2.Turn, ["id", "items", "status"], "Turn"),
    validateShape(
      definitions.v2.ErrorNotification,
      ["error", "threadId", "turnId", "willRetry"],
      "error notification",
    ),
    validateShape(
      definitions.v2.TurnStartedNotification,
      ["threadId", "turn"],
      "turn/started notification",
    ),
    validateShape(
      definitions.v2.TurnCompletedNotification,
      ["threadId", "turn"],
      "turn/completed notification",
    ),
    validateShape(
      definitions.v2.ItemStartedNotification,
      ["item", "threadId", "turnId"],
      "item/started notification",
    ),
    validateShape(
      definitions.v2.ItemCompletedNotification,
      ["item", "threadId", "turnId"],
      "item/completed notification",
    ),
    validateShape(
      definitions.v2.AgentMessageDeltaNotification,
      ["delta", "itemId", "threadId", "turnId"],
      "agent-message delta",
    ),
    validateShape(
      definitions.v2.CommandExecutionOutputDeltaNotification,
      ["delta", "itemId", "threadId", "turnId"],
      "command-output delta",
    ),
    validateShape(
      definitions.v2.FileChangeOutputDeltaNotification,
      ["delta", "itemId", "threadId", "turnId"],
      "file-change delta",
    ),
    validateShape(
      definitions.v2.FileChangePatchUpdatedNotification,
      ["changes", "itemId", "threadId", "turnId"],
      "file-change patch",
    ),
    validateShape(
      definitions.v2.ServerRequestResolvedNotification,
      ["requestId", "threadId"],
      "request resolution",
    ),
    validateShape(
      definitions.v2.McpToolCallProgressNotification,
      ["itemId", "message", "threadId", "turnId"],
      "MCP progress",
    ),
    validateShape(
      definitions.CommandExecutionRequestApprovalParams,
      ["itemId", "threadId", "turnId"],
      "command approval params",
    ),
    validateNullableStringProperty(
      definitions.CommandExecutionRequestApprovalParams,
      "command",
      "command approval params",
    ),
    validateEnumMembers(
      definitions.CommandExecutionApprovalKind.enum,
      ["command"],
      "command approval kind",
    ),
    validatePrimitiveUnion(
      definitions.v2.RequestId,
      ["string", "integer"],
      "request id",
    ),
    validateShape(
      definitions.CommandExecutionRequestApprovalResponse,
      ["decision"],
      "command approval response",
    ),
    validateLiteralUnion(
      definitions.CommandExecutionApprovalDecision,
      ["accept", "decline"],
      "command approval decision",
    ),
    validateShape(
      definitions.FileChangeRequestApprovalParams,
      ["itemId", "threadId", "turnId"],
      "file approval params",
    ),
    validateShape(
      definitions.FileChangeRequestApprovalResponse,
      ["decision"],
      "file approval response",
    ),
    validateLiteralUnion(
      definitions.FileChangeApprovalDecision,
      ["accept", "decline"],
      "file approval decision",
    ),
  ];
  for (const schemaFact of REQUIRED_SCHEMA_FACTS) {
    checks.push(validateSchemaFact(parsed.data, schemaFact));
  }
  const incompatible = checks.find((check) => check !== undefined);
  if (incompatible !== undefined) {
    return { ok: false, diagnostics: incompatible };
  }
  return { ok: true };
}

type TVariant = z.infer<typeof variantSchema>;

function validateVariants(
  variants: readonly TVariant[],
  discriminator: "method" | "type",
  requiredVariants: TRequiredVariants,
  label: string,
): string | undefined {
  for (const [name, requiredFields] of Object.entries(requiredVariants)) {
    const variant = variants.find((candidate) =>
      candidate.properties[discriminator]?.enum.includes(name),
    );
    if (variant === undefined) return `missing required ${label} '${name}'`;
    const required = variant.required ?? [];
    const missing = requiredFields.find((field) => !required.includes(field));
    if (missing !== undefined) {
      return `${label} '${name}' no longer requires '${missing}'`;
    }
    const missingShape = requiredFields.find(
      (field) => !isRecord(variant.properties[field]),
    );
    if (missingShape !== undefined) {
      return `${label} '${name}' has no schema for '${missingShape}'`;
    }
  }
  return undefined;
}

function validateNullableStringField(
  variants: readonly TVariant[],
  variantName: string,
  field: string,
  label: string,
): string | undefined {
  const variant = variants.find((candidate) =>
    candidate.properties.type?.enum.includes(variantName),
  );
  const property = variant?.properties[field];
  if (!isRecord(property)) return `${label} '${variantName}' has no '${field}'`;
  const types = property.type;
  if (
    !Array.isArray(types) ||
    !types.includes("string") ||
    !types.includes("null")
  ) {
    return `${label} '${variantName}.${field}' is no longer nullable string`;
  }
  return undefined;
}

function validateVariantReferences(
  variants: readonly TVariant[],
  discriminator: "method" | "type",
  expectedRefs: Readonly<Record<string, string>>,
  label: string,
): string | undefined {
  for (const [name, expectedRef] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties[discriminator]?.enum.includes(name),
    );
    if (variant === undefined) continue;
    const params = variant.properties.params;
    if (!isRecord(params) || params.$ref !== expectedRef) {
      return `${label} '${name}' params no longer reference '${expectedRef}'`;
    }
  }
  return undefined;
}

function validateVariantFieldReferencesByDiscriminator(
  variants: readonly TVariant[],
  discriminator: "method" | "type",
  field: string,
  expectedRefs: Readonly<Record<string, string>>,
  label: string,
): string | undefined {
  for (const [name, expectedRef] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties[discriminator]?.enum.includes(name),
    );
    if (variant === undefined) continue;
    if (schemaReference(variant.properties[field]) !== expectedRef) {
      return `${label} '${name}.${field}' no longer references '${expectedRef}'`;
    }
  }
  return undefined;
}

function validateEnumMembers(
  actual: readonly string[],
  required: readonly string[],
  label: string,
): string | undefined {
  const missing = required.find((member) => !actual.includes(member));
  return missing === undefined ? undefined : `${label} is missing '${missing}'`;
}

function validatePrimitiveUnion(
  union: z.infer<typeof primitiveUnionSchema>,
  required: readonly string[],
  label: string,
): string | undefined {
  const actual = union.anyOf.flatMap((variant) =>
    variant.type === undefined ? [] : [variant.type],
  );
  const missing = required.find((type) => !actual.includes(type));
  return missing === undefined ? undefined : `${label} is missing '${missing}'`;
}

function validateVariantFieldTypes(
  variants: readonly TVariant[],
  expectedTypes: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  for (const [name, fields] of Object.entries(expectedTypes)) {
    const variant = variants.find((candidate) =>
      candidate.properties.type?.enum.includes(name),
    );
    if (variant === undefined) continue;
    for (const [field, expectedType] of Object.entries(fields)) {
      const property = variant.properties[field];
      if (!isRecord(property) || property.type !== expectedType) {
        return `thread item '${name}.${field}' is no longer type '${expectedType}'`;
      }
    }
  }
  return undefined;
}

function validateVariantFieldReferences(
  variants: readonly TVariant[],
  expectedRefs: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  for (const [name, fields] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties.type?.enum.includes(name),
    );
    if (variant === undefined) continue;
    for (const [field, expectedRef] of Object.entries(fields)) {
      const property = variant.properties[field];
      if (schemaReference(property) !== expectedRef) {
        return `thread item '${name}.${field}' no longer references '${expectedRef}'`;
      }
    }
  }
  return undefined;
}

function validateVariantArrayItemReferences(
  variants: readonly TVariant[],
  expectedRefs: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  for (const [name, fields] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties.type?.enum.includes(name),
    );
    if (variant === undefined) continue;
    for (const [field, expectedRef] of Object.entries(fields)) {
      const property = variant.properties[field];
      if (
        !isRecord(property) ||
        schemaReference(property.items) !== expectedRef
      ) {
        return `thread item '${name}.${field}' items no longer reference '${expectedRef}'`;
      }
    }
  }
  return undefined;
}

function validateNullableStringProperty(
  shape: z.infer<typeof shapeSchema>,
  field: string,
  label: string,
): string | undefined {
  const property = shape.properties?.[field];
  if (!isRecord(property)) return `${label} has no schema for '${field}'`;
  const types = property.type;
  if (
    !Array.isArray(types) ||
    !types.includes("string") ||
    !types.includes("null")
  ) {
    return `${label} '${field}' is no longer nullable string`;
  }
  return undefined;
}

function schemaReference(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref === "string") return value.$ref;
  const allOf = value.allOf;
  if (!Array.isArray(allOf) || !isRecord(allOf[0])) return undefined;
  return typeof allOf[0].$ref === "string" ? allOf[0].$ref : undefined;
}

function validateMembers(
  actual: readonly string[],
  required: readonly string[],
  label: string,
): string | undefined {
  const missing = required.find((member) => !actual.includes(member));
  return missing === undefined
    ? undefined
    : `missing required ${label} '${missing}'`;
}

type TShape = z.infer<typeof shapeSchema>;

function validateShape(
  shape: TShape,
  requiredFields: readonly string[],
  label: string,
): string | undefined {
  const required = shape.required ?? [];
  const missing = requiredFields.find((field) => !required.includes(field));
  if (missing !== undefined) return `${label} no longer requires '${missing}'`;
  const missingShape = requiredFields.find(
    (field) => !isRecord(shape.properties?.[field]),
  );
  return missingShape === undefined
    ? undefined
    : `${label} has no schema for '${missingShape}'`;
}

type TLiteralUnion = z.infer<typeof literalUnionSchema>;

function validateLiteralUnion(
  union: TLiteralUnion,
  requiredValues: readonly string[],
  label: string,
): string | undefined {
  const values = union.oneOf.flatMap((variant) => variant.enum ?? []);
  return validateMembers(values, requiredValues, label);
}

function fact(
  label: string,
  expected: string,
  ...path: readonly string[]
): TSchemaFact {
  return { path, expected, label };
}

function validateSchemaFact(
  schema: unknown,
  schemaFact: TSchemaFact,
): string | undefined {
  let current = schema;
  for (const segment of schemaFact.path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || current[index] === undefined) {
        return `${schemaFact.label} schema path is missing`;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !(segment in current)) {
      return `${schemaFact.label} schema path is missing`;
    }
    current = current[segment];
  }
  if (current !== schemaFact.expected) {
    return `${schemaFact.label} changed from '${schemaFact.expected}'`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
