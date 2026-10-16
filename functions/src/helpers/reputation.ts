// Turns the quality and status webhooks Meta sends (they are never overridden to the customer, so
// they reach Watobot) into updates for the number records they concern. Only what is not in good
// standing is kept for templates: a template that turns green is removed.

export const templateKey = (name: string, language: string) => `${name}__${language}`.replace(/[^A-Za-z0-9_]/g, '_');

/** The digits of a phone number, to compare "+1 555-339-3615" with "15553393615". */
export const digitsOf = (phone: string | undefined) => (phone ?? '').replace(/\D/g, '');

export interface ReputationUpdate {
  /** The Messaging account the event came in on; the numbers using it are the ones to update. */
  wabaId: string;
  /** For a number event: only the number with this display number, when the account has several. */
  displayPhoneNumber?: string;
  /** Dotted Firestore paths to set. */
  set: Record<string, unknown>;
  /** Dotted paths to remove. */
  remove: string[];
  /** Only change the template if it is already tracked (an approval says nothing about a template that was never flagged). */
  onlyIfTracked?: string;
}

type Change = { field?: string; value?: Record<string, any> };

export function reputationUpdates(body: any, now = Date.now()): ReputationUpdate[] {
  const updates: ReputationUpdate[] = [];
  for (const entry of body?.entry ?? []) {
    const wabaId = String(entry?.id ?? '');
    for (const change of (entry?.changes ?? []) as Change[]) {
      const v = change.value ?? {};
      if (change.field === 'phone_number_quality_update') {
        updates.push({
          wabaId,
          displayPhoneNumber: v.display_phone_number,
          set: {
            'reputation.number.event': v.event ?? null,
            'reputation.number.currentLimit': v.current_limit ?? null,
            'reputation.number.at': now,
          },
          remove: [],
        });
      } else if (change.field === 'message_template_quality_update') {
        const key = templateKey(String(v.message_template_name ?? ''), String(v.message_template_language ?? ''));
        const score = String(v.new_quality_score ?? '');
        if (score === 'GREEN') {
          updates.push({ wabaId, set: {}, remove: [`reputation.templates.${key}`] });
        } else {
          updates.push({
            wabaId,
            set: { [`reputation.templates.${key}`]: { name: v.message_template_name, language: v.message_template_language, score, at: now } },
            remove: [],
          });
        }
      } else if (change.field === 'message_template_status_update') {
        const key = templateKey(String(v.message_template_name ?? ''), String(v.message_template_language ?? ''));
        const status = String(v.event ?? '');
        if (status === 'APPROVED') {
          updates.push({ wabaId, set: { [`reputation.templates.${key}.status`]: status, [`reputation.templates.${key}.at`]: now }, remove: [], onlyIfTracked: key });
        } else if (status) {
          updates.push({
            wabaId,
            set: { [`reputation.templates.${key}.name`]: v.message_template_name, [`reputation.templates.${key}.language`]: v.message_template_language, [`reputation.templates.${key}.status`]: status, [`reputation.templates.${key}.at`]: now },
            remove: [],
          });
        }
      }
    }
  }
  return updates;
}
