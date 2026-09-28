const stringArgument = (flag, {
  required = false,
  maxLength = 2_000,
  values,
} = {}) => Object.freeze({
  flag,
  type: "string",
  required,
  maxLength,
  ...(values ? { values: Object.freeze(values) } : {}),
});

const booleanArgument = (flag) => Object.freeze({ flag, type: "boolean" });
const integerArgument = (flag, minimum, maximum) => Object.freeze({
  flag,
  type: "integer",
  minimum,
  maximum,
});

const effectDriver = ({
  idempotency = "none",
  reconcile = "none",
  cancel = "none",
  resourceType,
  externalIdPaths = [],
  containerArgument,
} = {}) => Object.freeze({
  idempotency,
  reconcile,
  cancel,
  resourceType,
  externalIdPaths: Object.freeze(externalIdPaths.map((path) => Object.freeze([...path]))),
  ...(containerArgument ? { containerArgument } : {}),
});

const policy = ({
  action,
  skillNames,
  command,
  effect,
  arguments: argumentDefinitions,
  driver = effectDriver(),
  validate,
}) => Object.freeze({
  action,
  skillNames: Object.freeze(skillNames),
  command: Object.freeze(command),
  effect,
  confirmationRequired: effect === "write",
  arguments: Object.freeze(argumentDefinitions),
  driver,
  ...(validate ? { validate } : {}),
});

const oneOf = (values, message) => {
  const count = values.filter((value) => typeof value === "string" && value.length > 0).length;
  return count === 1 ? null : message;
};

export const LARK_TOOL_POLICIES = Object.freeze([
  policy({
    action: "lark.calendar.agenda",
    skillNames: ["lark-calendar"],
    command: ["calendar", "+agenda"],
    effect: "read",
    arguments: {
      start: stringArgument("--start", { maxLength: 64 }),
      end: stringArgument("--end", { maxLength: 64 }),
      calendarId: stringArgument("--calendar-id", { maxLength: 256 }),
    },
  }),
  policy({
    action: "lark.calendar.create",
    skillNames: ["lark-calendar"],
    command: ["calendar", "+create"],
    effect: "write",
    driver: effectDriver({
      idempotency: "none",
      reconcile: "query",
      cancel: "cooperative",
      resourceType: "calendar_event",
      externalIdPaths: [
        ["event_id"], ["eventId"], ["event", "event_id"], ["event", "eventId"],
        ["data", "event_id"], ["data", "eventId"],
      ],
      containerArgument: "calendarId",
    }),
    arguments: {
      summary: stringArgument("--summary", { required: true, maxLength: 512 }),
      start: stringArgument("--start", { required: true, maxLength: 64 }),
      end: stringArgument("--end", { required: true, maxLength: 64 }),
      description: stringArgument("--description", { maxLength: 4_000 }),
      attendeeIds: stringArgument("--attendee-ids", { maxLength: 4_000 }),
      calendarId: stringArgument("--calendar-id", { maxLength: 256 }),
      rrule: stringArgument("--rrule", { maxLength: 1_000 }),
    },
  }),
  policy({
    action: "lark.task.list_mine",
    skillNames: ["lark-task"],
    command: ["task", "+get-my-tasks"],
    effect: "read",
    arguments: {
      query: stringArgument("--query", { maxLength: 512 }),
      complete: booleanArgument("--complete"),
      createdAt: stringArgument("--created_at", { maxLength: 64 }),
      dueStart: stringArgument("--due-start", { maxLength: 64 }),
      dueEnd: stringArgument("--due-end", { maxLength: 64 }),
      pageAll: booleanArgument("--page-all"),
      pageLimit: integerArgument("--page-limit", 1, 40),
      pageToken: stringArgument("--page-token", { maxLength: 512 }),
    },
  }),
  policy({
    action: "lark.task.create",
    skillNames: ["lark-task"],
    command: ["task", "+create"],
    effect: "write",
    driver: effectDriver({
      idempotency: "provider_key",
      reconcile: "query",
      cancel: "cooperative",
      resourceType: "task",
      externalIdPaths: [
        ["task_id"], ["taskId"], ["guid"], ["task", "task_id"], ["task", "taskId"],
        ["task", "guid"], ["data", "task_id"], ["data", "taskId"], ["data", "guid"],
      ],
      containerArgument: "tasklistId",
    }),
    arguments: {
      summary: stringArgument("--summary", { required: true, maxLength: 512 }),
      description: stringArgument("--description", { maxLength: 4_000 }),
      due: stringArgument("--due", { maxLength: 64 }),
      assignee: stringArgument("--assignee", { maxLength: 256 }),
      follower: stringArgument("--follower", { maxLength: 256 }),
      tasklistId: stringArgument("--tasklist-id", { maxLength: 2_000 }),
    },
  }),
  policy({
    action: "lark.im.search_messages",
    skillNames: ["lark-im"],
    command: ["im", "+messages-search"],
    effect: "read",
    arguments: {
      query: stringArgument("--query", { maxLength: 512 }),
      chatId: stringArgument("--chat-id", { maxLength: 4_000 }),
      sender: stringArgument("--sender", { maxLength: 4_000 }),
      start: stringArgument("--start", { maxLength: 64 }),
      end: stringArgument("--end", { maxLength: 64 }),
      pageAll: booleanArgument("--page-all"),
      pageLimit: integerArgument("--page-limit", 1, 40),
      pageSize: integerArgument("--page-size", 1, 50),
      pageToken: stringArgument("--page-token", { maxLength: 512 }),
      isAtMe: booleanArgument("--is-at-me"),
      noReactions: booleanArgument("--no-reactions"),
    },
  }),
  policy({
    action: "lark.im.send_message",
    skillNames: ["lark-im"],
    command: ["im", "+messages-send"],
    effect: "write",
    driver: effectDriver({
      idempotency: "provider_key",
      reconcile: "query",
      cancel: "cooperative",
      resourceType: "message",
      externalIdPaths: [
        ["message_id"], ["messageId"], ["message", "message_id"], ["message", "messageId"],
        ["data", "message_id"], ["data", "messageId"],
      ],
    }),
    arguments: {
      chatId: stringArgument("--chat-id", { maxLength: 256 }),
      userId: stringArgument("--user-id", { maxLength: 256 }),
      text: stringArgument("--text", { maxLength: 20_000 }),
      markdown: stringArgument("--markdown", { maxLength: 20_000 }),
    },
    validate: (args) => (
      oneOf([args.chatId, args.userId], "Exactly one message recipient is required.")
      ?? oneOf([args.text, args.markdown], "Exactly one message body is required.")
    ),
  }),
  policy({
    action: "lark.docs.fetch",
    skillNames: ["lark-doc"],
    command: ["docs", "+fetch", "--api-version", "v2"],
    effect: "read",
    arguments: {
      doc: stringArgument("--doc", { required: true, maxLength: 2_000 }),
      detail: stringArgument("--detail", { values: ["simple", "with-ids", "full"] }),
      docFormat: stringArgument("--doc-format", { values: ["xml", "markdown"] }),
      scope: stringArgument("--scope", { values: ["full", "outline", "range", "keyword", "section"] }),
      keyword: stringArgument("--keyword", { maxLength: 512 }),
      startBlockId: stringArgument("--start-block-id", { maxLength: 256 }),
      endBlockId: stringArgument("--end-block-id", { maxLength: 256 }),
      maxDepth: integerArgument("--max-depth", -1, 100),
    },
  }),
  policy({
    action: "lark.minutes.search",
    skillNames: ["lark-minutes"],
    command: ["minutes", "+search"],
    effect: "read",
    arguments: {
      query: stringArgument("--query", { maxLength: 512 }),
      start: stringArgument("--start", { maxLength: 64 }),
      end: stringArgument("--end", { maxLength: 64 }),
      ownerIds: stringArgument("--owner-ids", { maxLength: 4_000 }),
      participantIds: stringArgument("--participant-ids", { maxLength: 4_000 }),
      pageSize: integerArgument("--page-size", 1, 30),
      pageToken: stringArgument("--page-token", { maxLength: 512 }),
    },
  }),
]);

const POLICIES_BY_ACTION = new Map(LARK_TOOL_POLICIES.map((entry) => [entry.action, entry]));

export function getLarkToolPolicy(action) {
  return POLICIES_BY_ACTION.get(action) ?? null;
}

export function listLarkToolPoliciesForSkill(skillName) {
  return LARK_TOOL_POLICIES.filter((entry) => entry.skillNames.includes(skillName));
}

export function projectLarkToolDeclaration(action, skillName) {
  const entry = getLarkToolPolicy(action);
  if (!entry || !entry.skillNames.includes(skillName)) return null;
  return {
    action: entry.action,
    effect: entry.effect,
    confirm: entry.confirmationRequired,
  };
}
