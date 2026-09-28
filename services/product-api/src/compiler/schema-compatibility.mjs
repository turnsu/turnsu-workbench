const INVALID_ESCAPE = /~(?:[^01]|$)/;

export function parseMappingExpression(expression) {
  if (expression === undefined || expression === "identity") {
    return { kind: "identity" };
  }

  if (typeof expression !== "string" || !expression.startsWith("/")) {
    return null;
  }

  const encodedTokens = expression.slice(1).split("/");
  if (encodedTokens.some((token) => INVALID_ESCAPE.test(token))) {
    return null;
  }

  return {
    kind: "jsonPointer",
    expression,
    tokens: encodedTokens.map((token) =>
      token.replaceAll("~1", "/").replaceAll("~0", "~"),
    ),
  };
}

export function schemaAtMapping(sourceSchema, mapping) {
  if (mapping.kind === "identity") {
    return sourceSchema;
  }

  let schema = sourceSchema;
  for (const token of mapping.tokens) {
    if (schema?.type === "object") {
      if (
        schema.properties === undefined ||
        !Object.prototype.hasOwnProperty.call(schema.properties, token)
      ) {
        return null;
      }
      schema = schema.properties[token];
      continue;
    }

    if (schema?.type === "array" && /^(0|[1-9][0-9]*)$/.test(token)) {
      if (schema.items === undefined) {
        return null;
      }
      schema = schema.items;
      continue;
    }

    return null;
  }

  return schema;
}

const enumAssignable = (source, target) => {
  if (!Array.isArray(target.enum)) {
    return true;
  }
  if (!Array.isArray(source.enum)) {
    return false;
  }
  const allowed = new Set(target.enum.map((value) => JSON.stringify(value)));
  return source.enum.every((value) => allowed.has(JSON.stringify(value)));
};

const boundsAssignable = (source, target, minimumKey, maximumKey) => {
  if (
    target[minimumKey] !== undefined &&
    (source[minimumKey] === undefined || source[minimumKey] < target[minimumKey])
  ) {
    return false;
  }
  if (
    target[maximumKey] !== undefined &&
    (source[maximumKey] === undefined || source[maximumKey] > target[maximumKey])
  ) {
    return false;
  }
  return true;
};

export function isSchemaAssignable(source, target) {
  if (!source || !target || typeof source !== "object" || typeof target !== "object") {
    return false;
  }

  if (source.type !== target.type) {
    if (!(source.type === "integer" && target.type === "number")) {
      return false;
    }
  }

  if (!enumAssignable(source, target)) {
    return false;
  }

  if (target.type === "string") {
    if (!boundsAssignable(source, target, "minLength", "maxLength")) {
      return false;
    }
    if (target.pattern !== undefined && source.pattern !== target.pattern) {
      return false;
    }
    if (target.format !== undefined && source.format !== target.format) {
      return false;
    }
  }

  if (target.type === "number" || target.type === "integer") {
    if (!boundsAssignable(source, target, "minimum", "maximum")) {
      return false;
    }
  }

  if (target.type === "array" && target.items !== undefined) {
    if (source.items === undefined || !isSchemaAssignable(source.items, target.items)) {
      return false;
    }
  }

  if (target.type === "object") {
    const sourceProperties = source.properties ?? {};
    const targetProperties = target.properties ?? {};
    const sourceRequired = new Set(source.required ?? []);

    for (const propertyName of target.required ?? []) {
      if (
        !sourceRequired.has(propertyName) ||
        sourceProperties[propertyName] === undefined ||
        targetProperties[propertyName] === undefined ||
        !isSchemaAssignable(
          sourceProperties[propertyName],
          targetProperties[propertyName],
        )
      ) {
        return false;
      }
    }

    for (const [propertyName, sourceProperty] of Object.entries(sourceProperties)) {
      const targetProperty = targetProperties[propertyName];
      if (targetProperty && !isSchemaAssignable(sourceProperty, targetProperty)) {
        return false;
      }
      if (targetProperty === undefined && target.additionalProperties === false) {
        return false;
      }
    }
  }

  return true;
}
