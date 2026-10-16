// Turns a template list a previous provider exported into requests that create those templates.
//
// The export is Meta's own read format (GET /<WABA_ID>/message_templates). Reading returns fields
// that creating does not accept (`id`, `status`, `quality_score` and so on), so only the four
// fields a create needs are kept.

export interface TemplateCreatePayload {
  name: string;
  language: string;
  category: string;
  components: unknown[];
  parameter_format?: string;
}

export interface TemplateRejection {
  name: string;
  language: string;
  reason: string;
}

export interface ParsedTemplates {
  templates: TemplateCreatePayload[];
  rejected: TemplateRejection[];
}

/** Accepts the whole GET response (`{ data: [...] }`) or just the array. */
export function parseTemplateExport(input: unknown): ParsedTemplates {
  const list = Array.isArray(input) ? input : Array.isArray((input as { data?: unknown })?.data) ? (input as { data: unknown[] }).data : null;
  if (!list) return { templates: [], rejected: [{ name: '(the pasted JSON)', language: '', reason: 'Expected a list of templates, or an object with a "data" list.' }] };

  const templates: TemplateCreatePayload[] = [];
  const rejected: TemplateRejection[] = [];
  for (const item of list) {
    const t = (item ?? {}) as Record<string, unknown>;
    const name = typeof t.name === 'string' ? t.name : '';
    const language = typeof t.language === 'string' ? t.language : '';
    const category = typeof t.category === 'string' ? t.category : '';
    if (!name || !language || !category || !Array.isArray(t.components)) {
      rejected.push({ name: name || '(no name)', language, reason: 'Needs a name, language, category and components.' });
      continue;
    }
    const payload: TemplateCreatePayload = { name, language, category, components: t.components };
    if (typeof t.parameter_format === 'string') payload.parameter_format = t.parameter_format;
    templates.push(payload);
  }
  return { templates, rejected };
}
