// Only historical pages translate names. New pages persist OpenUI state as-is.
export function rendererState(document) {
  if (!document.migration) return document.data;
  return Object.fromEntries(Object.entries(document.migration.bindings)
    .filter(([, key]) => Object.hasOwn(document.data, key))
    .map(([variable, key]) => [variable, document.data[key]]));
}

export function taskValues(document, values) {
  if (!document.migration) return values;
  const editable = new Set(document.migration.fields.map(field => field.binding));
  return Object.fromEntries(Object.entries(document.migration.bindings)
    .filter(([variable, key]) => editable.has(key) && Object.hasOwn(values, variable))
    .map(([variable, key]) => [key, values[variable]]));
}

export function sendsToAssistant(plan, defaultSend = false) {
  return plan ? Boolean(plan.steps?.some(step => step.type === 'continue_conversation')) : defaultSend;
}

export const confirmationLabels = {
  confirmed: '已确认',
  pending: '已确认，等待接收',
  dispatching: '正在交给助手',
  uncertain: '接收状态待核对',
};
