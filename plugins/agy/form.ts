import { list, object, text, type Wire } from "./acp";

function choices(schema: Wire): { label: string; value: string }[] {
  const values = list(schema.enum);
  if (values.length) return values.filter((value): value is string => typeof value === "string").map(value => ({ label: value, value }));
  return list(schema.oneOf).map(object).filter(choice => typeof choice.const === "string").map(choice => ({
    label: text(choice.title) || text(choice.const), value: text(choice.const),
  }));
}

export function form(params: Wire) {
  const schema = object(params.requestedSchema);
  const entries = Object.entries(object(schema.properties));
  if (params.mode !== "form" || schema.type !== "object" || !entries.length) return null;
  const message = text(params.message);
  const required = new Set(list(schema.required));
  const fields = entries.map(([key, value]) => {
    const property = object(value);
    const label = text(property.title) || key;
    const options = choices(property);
    const question = [...new Set([message, text(property.description) || label].filter(Boolean))].join("\n");
    return { key, options, question, property };
  });
  if (fields.some(({ property, options }) => property.type !== "string"
      || (property.enum !== undefined || property.oneOf !== undefined) && !options.length)
    || new Set(fields.map(field => field.question)).size !== fields.length) return null;
  return {
    input: { questions: fields.map(({ question, options }) => ({ question, options: options.map(({ label }) => ({ label })) })) },
    submit(answers: Record<string, string>): Wire {
      const content: [string, string][] = [];
      for (const { key, options, question, property } of fields) {
        const answer = answers[question];
        if (!answer) {
          if (required.has(key)) return { action: "decline" };
          continue;
        }
        const selected = options.length ? options.find(option => option.label === answer)?.value : answer;
        if (selected === undefined || typeof property.minLength === "number" && selected.length < property.minLength
          || typeof property.maxLength === "number" && selected.length > property.maxLength) return { action: "decline" };
        content.push([key, selected]);
      }
      return { action: "accept", content: Object.fromEntries(content) };
    },
  };
}
