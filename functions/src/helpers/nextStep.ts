import { effectiveStep } from './onboardingSteps';
import { counts } from './gates';
import type { NextStep, PhoneNumberDoc } from './types';

const SYNC_TYPES = ['contacts', 'history'] as const;

/**
 * What the person (and an AI tool helping them) does next, for the step the number is at. The tool names
 * are the Watobot MCP tools, which are one-to-one with the API calls of the same name.
 */
export function nextStep(doc: PhoneNumberDoc, now = Date.now()): NextStep {
  const step = effectiveStep(doc);

  if (!doc.encAccessToken) {
    return {
      step,
      title: 'Connect the number again',
      instruction:
        "Watobot no longer holds Meta access for this number (the API key was reset). The person has to go through Meta's sign-up again: call start_onboarding_link and give them the link. They do the Meta sign-up in their browser; no tool can do it.",
      tools: ['start_onboarding_link'],
    };
  }

  switch (step) {
    case 'override':
      return {
        step,
        title: 'Choose where incoming messages go',
        instruction:
          'Ask whether the person wants incoming messages in an app of their own. If yes: check_callback_url with their URL, optionally send_test_events (the only way to know their endpoint stores the one-time contacts and history sync), then verify_test_codes with the four codes. Then call start_onboarding_link with the URL. If they have no callback URL, say plainly that no incoming messages or delivery receipts reach them and the contacts and history sync is skipped for good, get their agreement, and call start_onboarding_link without one. Meta\'s sign-up (Facebook login, the WhatsApp Business app\'s code or QR) is done by the person in their browser; no tool can do it. Afterwards call get_number until the number appears.',
        tools: ['check_callback_url', 'send_test_events', 'verify_test_codes', 'start_onboarding_link', 'get_number'],
      };

    case 'not_on_app':
      return {
        step,
        title: 'Continue with the API alone',
        instruction:
          'This number is not on the WhatsApp Business app, so it runs on the API alone. Ask the person for a six-digit PIN they will keep (it is the number\'s two-step verification PIN), then call register_number with it. That moves the number on to templates.',
        tools: ['register_number'],
      };

    case 'register':
      return {
        step,
        title: 'Register the number',
        instruction: 'Ask the person for a six-digit PIN they will keep (the number\'s two-step verification PIN) and call register_number with it. If Meta refuses it, tell them why and try again.',
        tools: ['register_number'],
      };

    case 'sync': {
      const left = SYNC_TYPES.filter((t) => !['requested', 'skipped'].includes(doc.sync?.[t]?.state ?? ''));
      const failed = left.filter((t) => doc.sync?.[t]?.state === 'failed');
      return {
        step,
        title: 'Sync contacts and history',
        instruction:
          `Meta sends a coexistence number's contacts and then its chat history to the callback URL, once each, within 24 hours of onboarding. Still to request: ${left.join(', ')}${failed.length ? ` (${failed.join(' and ')} failed last time; it can be asked again)` : ''}. Call start_sync for contacts first, then history. If the person does not want them, ask first and call skip_sync: it skips both for good.`,
        tools: ['start_sync', 'skip_sync'],
      };
    }

    case 'templates':
      return {
        step,
        title: 'Bring over your templates',
        instruction:
          'Templates belong to the Messaging account. To copy approved ones from the previous Messaging account call migrate_templates; to create them from an export call import_templates; list_templates shows what exists. When the person is done, or has none to bring, call set_onboarding_step with "done".',
        tools: ['migrate_templates', 'import_templates', 'list_templates', 'set_onboarding_step'],
      };

    default: {
      const problem = doc.health?.reasons.filter((r) => counts(r, now) && r.severity !== 'info')[0];
      return {
        step,
        title: 'Set up',
        instruction: problem
          ? `Onboarding is complete, but sending is held up: ${problem.title}. ${problem.action} Tell the person, and call get_number with refresh after they say it is fixed. Otherwise: send_message to send, get_limits for the room left, list_templates and create_template for templates.`
          : 'Onboarding is complete. send_message sends; get_limits shows the room left; list_templates and create_template manage templates.',
        tools: ['send_message', 'get_limits', 'list_templates', 'create_template', 'get_number'],
      };
    }
  }
}

/** The step and what to do next, read from the record as it stands now (for the answer to a call that moved it). */
export const progressOf = (doc: PhoneNumberDoc) => ({ step: effectiveStep(doc), next: nextStep(doc) });
