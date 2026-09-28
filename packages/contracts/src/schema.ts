import { Type, type TObjectOptions, type TProperties } from "typebox";

export function strictObject<const Properties extends TProperties>(
  properties: Properties,
  options: TObjectOptions = {},
) {
  return Type.Object(properties, {
    ...options,
    additionalProperties: false,
  });
}

export function stringEnum<const Values extends readonly [string, ...string[]]>(
  values: Values,
) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}
